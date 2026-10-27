import type { WriteRequest } from './opfs-writer.js';

/** Errors of handles that do not exist (any more) or have the other kind. */
export function isMissing(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

/** The engine replaces files by rename: reading can fail for a moment. */
export function isTransient(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'NotReadableError';
}

/** Directory below `parent`, null when it does not exist. */
export async function folder(
  parent: FileSystemDirectoryHandle | null,
  names: readonly string[],
  create = false,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = parent;
  if (!dir) return null;
  try {
    for (const name of names) dir = await dir.getDirectoryHandle(name, { create });
    return dir;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Entries of a directory, empty when it does not exist (any more): indexedDB.deleteDatabase can
 * remove a directory while it is read.
 */
export async function children(dir: FileSystemDirectoryHandle | null): Promise<FileSystemHandle[]> {
  const all: FileSystemHandle[] = [];
  if (!dir) return all;
  try {
    for await (const handle of dir.values()) all.push(handle);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return all;
}

function split(path: string): [string[], string] {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  return [parts, name];
}

// The writer worker of browsers without createWritable, ended when idle
const WRITER_IDLE_MS = 5000;
interface Writer {
  worker: Worker;
  pending: Map<number, { resolve(): void; reject(error: Error): void }>;
  timer?: ReturnType<typeof setTimeout>;
}
let writer: Writer | null = null;
let nextWrite = 1;

/** Writes through opfs-writer.ts: Safari 18 has synchronous access handles only in workers. */
async function writeInWorker(
  handle: FileSystemFileHandle,
  data: BufferSource | string,
): Promise<void> {
  const path = await (await navigator.storage.getDirectory()).resolve(handle);
  if (!path) throw new DOMException('File outside the origin private file system', 'NotFoundError');
  if (!writer) {
    const worker = new Worker(new URL('./opfs-writer.js', import.meta.url), { type: 'module' });
    const current: Writer = { worker, pending: new Map() };
    worker.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
      const { id, error } = event.data;
      const entry = current.pending.get(id);
      current.pending.delete(id);
      if (error) entry?.reject(new DOMException(error, 'InvalidStateError'));
      else entry?.resolve();
    };
    worker.onerror = () => {
      worker.terminate();
      if (writer === current) writer = null;
      for (const entry of current.pending.values())
        entry.reject(new DOMException('The writer worker failed', 'InvalidStateError'));
      current.pending.clear();
    };
    writer = current;
  }
  const current = writer;
  clearTimeout(current.timer);
  const id = nextWrite++;
  const bytes =
    typeof data === 'string'
      ? data
      : ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data.slice(0);
  try {
    await new Promise<void>((resolve, reject) => {
      current.pending.set(id, { resolve, reject });
      current.worker.postMessage({ id, path, data: bytes } satisfies WriteRequest);
    });
  } finally {
    if (!current.pending.size)
      current.timer = setTimeout(() => {
        if (current.pending.size) return;
        current.worker.terminate();
        if (writer === current) writer = null;
      }, WRITER_IDLE_MS);
  }
}

/** Writes a file, creating its directories. */
export async function writeFile(
  top: FileSystemDirectoryHandle,
  path: string,
  data: BufferSource | string,
): Promise<File> {
  const [dirs, name] = split(path);
  const dir = await folder(top, dirs, true);
  if (!dir) throw new DOMException(`Cannot create ${path}`, 'NotFoundError');
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === 'function') {
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } else {
    await writeInWorker(handle, data);
  }
  return handle.getFile();
}

/** Removes a file or directory (recursively); nothing when it does not exist. */
export async function removePath(top: FileSystemDirectoryHandle, path: string): Promise<void> {
  const [dirs, name] = split(path);
  try {
    await (await folder(top, dirs))?.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Removes everything inside a directory. */
export async function clearDirectory(top: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of top.keys()) names.push(name);
  for (const name of names) {
    await top
      .removeEntry(name, { recursive: true })
      .catch((error: unknown) => console.warn('profile: cannot remove', name, error));
  }
}

/** Text of a file in `top`, null when missing. */
export async function readText(
  top: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    return await (await (await top.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

/** Bytes of all files below a directory. */
export async function folderSize(dir: FileSystemDirectoryHandle | null): Promise<number> {
  let size = 0;
  for (const handle of await children(dir)) {
    if (handle.kind === 'directory') size += await folderSize(handle as FileSystemDirectoryHandle);
    else
      size +=
        (
          await (handle as FileSystemFileHandle).getFile().then(
            (file) => file,
            () => null,
          )
        )?.size ?? 0;
  }
  return size;
}
