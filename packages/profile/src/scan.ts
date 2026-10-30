import { children, folder, isTransient } from './opfs.js';

/** A file of a database with size and modification time when it was read. */
export interface FileEntry {
  path: string;
  handle: FileSystemFileHandle;
  size: number;
  modified: number;
}

/**
 * A database of the profile: cookies.db, one .localstorage file or the directory of one
 * IndexedDB. `big` when larger than the limit (then not read completely), `unstable` while the
 * engine replaces one of its files.
 */
export interface Unit {
  key: string;
  files: FileEntry[];
  size: number;
  unstable: boolean;
  big: boolean;
}

/** Database a file belongs to. */
export function unitOf(path: string): string {
  return path.startsWith('indexeddb/') ? path.slice(0, path.lastIndexOf('/')) : path;
}

const encoder = new TextEncoder();

/**
 * Names the profile server accepts, without leftovers of broken databases and without hidden
 * files (the engine's commit logs).
 */
export function validName(name: string): boolean {
  return (
    name !== '' &&
    !name.startsWith('.') &&
    !name.includes('\\') &&
    !name.endsWith('-corrupted') &&
    encoder.encode(name).length <= 255
  );
}

/** Site of a profile file ("https://example.com") from the WebKit name `<scheme>_<host>_<port>`. */
export function siteOfPath(path: string): string {
  const parts = path.split('/');
  const id =
    parts[0] === 'localstorage' ? (parts[1] ?? '').replace(/\.localstorage$/, '') : parts[2] || '';
  const match = /^([a-z][a-z0-9+.-]*)_(.+)_(\d+)$/.exec(id);
  if (!match) return id;
  const [, scheme, host, port] = match;
  return `${scheme}://${host}${port === '0' ? '' : `:${port}`}`;
}

/** File with size and time, null while the engine replaces it. */
async function readEntry(handle: FileSystemFileHandle, path: string): Promise<FileEntry | null> {
  try {
    const file = await handle.getFile();
    return { path, handle, size: file.size, modified: file.lastModified };
  } catch (error) {
    if (isTransient(error)) return null;
    throw error;
  }
}

function fileUnit(key: string, entry: FileEntry | null, limit: number): Unit {
  return {
    key,
    files: entry ? [entry] : [],
    size: entry?.size ?? 0,
    unstable: !entry,
    big: key !== 'cookies.db' && (entry?.size ?? 0) > limit,
  };
}

async function fileHandle(
  dir: FileSystemDirectoryHandle | null,
  name: string,
): Promise<FileSystemFileHandle | null> {
  return dir
    ? dir.getFileHandle(name).then(
        (handle) => handle,
        () => null,
      )
    : null;
}

/**
 * Directory of an IndexedDB: IndexedDB.sqlite3 first, stop reading above the limit. null for an
 * empty directory (deleted database).
 */
async function databaseUnit(
  key: string,
  dir: FileSystemDirectoryHandle,
  limit: number,
): Promise<Unit | null> {
  const unit: Unit = { key, files: [], size: 0, unstable: false, big: false };
  const add = (entry: FileEntry | null) => {
    if (!entry) {
      unit.unstable = true;
      return false;
    }
    unit.files.push(entry);
    unit.size += entry.size;
    unit.big = unit.size > limit;
    return !unit.big;
  };
  const main = await fileHandle(dir, 'IndexedDB.sqlite3');
  if (!main) {
    const hasFiles = (await children(dir)).some(
      (handle) => handle.kind === 'file' && validName(handle.name),
    );
    return hasFiles ? { ...unit, unstable: true } : null;
  }
  if (!add(await readEntry(main, `${key}/IndexedDB.sqlite3`))) return unit;
  for (const handle of await children(dir)) {
    const { name } = handle;
    if (handle.kind !== 'file' || name === 'IndexedDB.sqlite3' || !validName(name)) continue;
    if (!add(await readEntry(handle as FileSystemFileHandle, `${key}/${name}`))) break;
  }
  return unit;
}

/**
 * Directories of the IndexedDBs: indexeddb/v1/<top origin>/<name>, for frames
 * <top origin>/<frame origin>/<name>. A directory with files but without IndexedDB.sqlite3 is
 * being replaced.
 */
async function* databaseFolders(
  top: FileSystemDirectoryHandle,
): AsyncGenerator<[string, FileSystemDirectoryHandle]> {
  for (const originDir of await children(await folder(top, ['indexeddb', 'v1']))) {
    if (originDir.kind !== 'directory' || !validName(originDir.name)) continue;
    for (const dir of await children(originDir as FileSystemDirectoryHandle)) {
      if (dir.kind !== 'directory' || !validName(dir.name)) continue;
      const handle = dir as FileSystemDirectoryHandle;
      const key = `indexeddb/v1/${originDir.name}/${dir.name}`;
      if (await fileHandle(handle, 'IndexedDB.sqlite3')) {
        yield [key, handle];
        continue;
      }
      const inner = (await children(handle)).filter(
        (entry) => entry.kind === 'directory' && validName(entry.name),
      );
      if (!inner.length) yield [key, handle];
      for (const entry of inner) yield [`${key}/${entry.name}`, entry as FileSystemDirectoryHandle];
    }
  }
}

/** All databases of the profile in the storage directory. */
export async function scan(top: FileSystemDirectoryHandle, limit: number): Promise<Unit[]> {
  const units: (Unit | null)[] = [];
  const cookies = await fileHandle(top, 'cookies.db');
  if (cookies) units.push(fileUnit('cookies.db', await readEntry(cookies, 'cookies.db'), limit));
  for (const handle of await children(await folder(top, ['localstorage']))) {
    const path = `localstorage/${handle.name}`;
    if (handle.kind === 'file' && handle.name.endsWith('.localstorage') && validName(handle.name))
      units.push(fileUnit(path, await readEntry(handle as FileSystemFileHandle, path), limit));
  }
  for await (const [key, dir] of databaseFolders(top))
    units.push(await databaseUnit(key, dir, limit));
  return units.filter((unit): unit is Unit => unit !== null);
}
