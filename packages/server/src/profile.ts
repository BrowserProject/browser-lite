// The browser profile on the server: cookies, localStorage, small IndexedDBs and the prefs of the
// page (JSON values by name), so a user stays signed in to websites, also on another device.
// Protocol: README.md.
//
// Under dir: profile.json (id, active session), files/<path> (paths as in /data of the engine),
// prefs/<name>.json and tmp/ for atomic writes (write file, fsync, rename).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { securityHeaders } from './headers.js';
import { hostCheck } from './hosts.js';

/** Options of {@link createProfileStore}. */
export interface ProfileStoreOptions {
  /** Directory of the profile; created if missing. Not writable: requests answer 503. */
  dir: string;
  /** Limit of all profile files together. Default 64 MiB. */
  maxBytes?: number;
  /** URL path prefix of the endpoint, ending with `/`. Default `'/profile/'`. */
  path?: string;
  /**
   * Host names the store answers under besides IP addresses and `localhost` (DNS rebinding
   * protection). An entry starting with `.` matches every name ending with it.
   */
  hosts?: string[];
  /**
   * Decides whether a request may use the profile (required), for example `authorizeToken` of
   * `@browser-lite/server/token` with audience `'profile'`. The profile holds the user's
   * sign-ins: pass `() => true` only for a store reachable by its user alone.
   */
  authorize(req: IncomingMessage, url: URL): boolean | Promise<boolean>;
  /** Where warnings and unexpected errors go. Default `console`. */
  logger?: Pick<Console, 'warn' | 'error'>;
}

/** The server side of `@browser-lite/profile`, answering under its `path`. */
export interface ProfileStore {
  /** Answers requests under `path` and resolves true when done; false for other paths. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Waits for pending writes. */
  close(): Promise<void>;
}

interface Profile {
  id: string;
  created: number;
  updated: number;
  session: string | null;
  device: string | null;
  opened: number | null;
  resetBy?: string;
}

interface FileEntry {
  path: string;
  size: number;
  modified: number;
}

const MB = 1024 * 1024;
const FILE_LIMIT = 32 * MB;
const JSON_LIMIT = MB;
/** Names of prefs: the file prefs/<name>.json. */
const PREF_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PREF_COUNT = 32;
const PREFS_LIMIT = 4 * MB;
// Of a refused body (413) this much is still read and dropped, so the client finishes sending and
// gets the answer: closing with unread data resets the connection and the answer can get lost.
// Larger bodies are cut off.
const DRAIN_LIMIT = 4 * MB;
// Errors that are not server errors (file system, aborted upload)
const ERROR_STATUS: Record<string, number> = {
  ENOTDIR: 400,
  EISDIR: 400,
  EEXIST: 400,
  ENOSPC: 507,
  EROFS: 503,
  EACCES: 503,
  EPERM: 503,
  ECONNRESET: 400,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;

function validName(name: string): boolean {
  return (
    name !== '' && !name.startsWith('.') && !/[/\\\0]/.test(name) && Buffer.byteLength(name) <= 255
  );
}

// Only the files that belong to a profile
function validPath(rel: string): boolean {
  const parts = rel.split('/');
  if (!parts.every(validName)) return false;
  if (parts.length === 1) return parts[0] === 'cookies.db';
  if (parts[0] === 'localstorage')
    return parts.length === 2 && (parts[1] as string).endsWith('.localstorage');
  return (
    parts[0] === 'indexeddb' && parts[1] === 'v1' && (parts.length === 5 || parts.length === 6)
  );
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const headers: Record<string, string> = { ...securityHeaders(), 'Cache-Control': 'no-store' };
  // A body larger than DRAIN_LIMIT is not read to its end
  if (status === 413) headers.Connection = 'close';
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res
    .writeHead(status, { ...headers, 'Content-Type': 'application/json' })
    .end(JSON.stringify(body));
}

// Passes the body in chunks to write, at most limit bytes (else 413). destroyOnReturn: false keeps
// the connection open so the answer still arrives.
async function receive(
  req: IncomingMessage,
  limit: number,
  write: (chunk: Buffer) => unknown,
): Promise<number> {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413);
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413);
    await write(chunk as Buffer);
  }
  return size;
}

// Reads and drops the rest of the request body, at most DRAIN_LIMIT
async function drain(req: IncomingMessage): Promise<void> {
  if (Number(req.headers['content-length']) > DRAIN_LIMIT) return;
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > DRAIN_LIMIT) return;
  }
}

async function receiveJSON(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  await receive(req, JSON_LIMIT, (chunk) => parts.push(chunk));
  try {
    return JSON.parse(Buffer.concat(parts).toString() || 'null');
  } catch {
    throw new HttpError(400);
  }
}

// JSON file, null if it is missing or broken
async function readJSON<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

// Size of a file, 0 if it does not exist
async function fileSize(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new HttpError(400);
    return stat.size;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0;
    throw error;
  }
}

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | false | undefined;

const field = (value: unknown, key: string) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Creates the store of exactly one browser profile in `dir`, the server side of
 * `@browser-lite/profile`. Every file is written atomically.
 */
export function createProfileStore(o: ProfileStoreOptions): ProfileStore {
  if (typeof o?.authorize !== 'function')
    throw new TypeError('createProfileStore: options.authorize is required');
  const { dir, authorize } = o;
  const base = o.path ?? '/profile/';
  if (!base.startsWith('/') || !base.endsWith('/'))
    throw new TypeError('createProfileStore: path must start and end with /');
  const maxBytes = o.maxBytes ?? 64 * MB;
  const logger = o.logger ?? console;
  const hostAllowed = hostCheck(o.hosts ?? []);
  const filesDir = path.join(dir, 'files');
  const prefsDir = path.join(dir, 'prefs');
  const tmpDir = path.join(dir, 'tmp');
  const profileFile = path.join(dir, 'profile.json');
  const prefFile = (name: string) => path.join(prefsDir, `${name}.json`);
  const tmpFile = () => path.join(tmpDir, crypto.randomUUID());
  let profile: Profile = {
    id: '',
    created: 0,
    updated: 0,
    session: null,
    device: null,
    opened: null,
  };
  let bytes = 0;

  // Everything that touches files/ or profile.json runs one after the other
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  async function writeAtomic(file: string, data: string): Promise<void> {
    const tmp = tmpFile();
    await fs.writeFile(tmp, data, { flush: true });
    await fs.rename(tmp, file);
  }
  const saveProfile = () => writeAtomic(profileFile, JSON.stringify(profile));
  const changed = () => {
    profile.updated = Date.now();
    return saveProfile();
  };
  const fresh = () => ({ id: crypto.randomUUID(), created: Date.now(), updated: Date.now() });

  // Other files in files/ do not belong to the profile and are never sent
  async function listFiles(): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    for (const entry of await fs.readdir(filesDir, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      const rel = path.relative(filesDir, file).split(path.sep).join('/');
      if (!entry.isFile() || !validPath(rel)) continue;
      const stat = await fs.stat(file);
      files.push({ path: rel, size: stat.size, modified: Math.round(stat.mtimeMs) });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // A session starts with the profile id at open time: an old session thus shows whether it
  // belongs to a profile that was reset since. The session that reset it (resetBy) belongs to
  // the new one.
  function checkSession(req: IncomingMessage): void {
    const session = req.headers['x-profile-session'];
    if (typeof session !== 'string' || !session) throw new HttpError(400);
    if (session !== profile.session) {
      const current = session.startsWith(`${profile.id}.`) || session === profile.resetBy;
      throw new HttpError(409, { reason: current ? 'taken' : 'reset' });
    }
  }

  async function init(): Promise<void> {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const sub of [filesDir, prefsDir, tmpDir]) await fs.mkdir(sub, { recursive: true });
    profile = (await readJSON<Profile>(profileFile)) ?? {
      ...fresh(),
      session: null,
      device: null,
      opened: null,
    };
    await saveProfile();
    bytes = (await listFiles()).reduce((sum, file) => sum + file.size, 0);
  }
  const ready = init().then(
    () => true,
    (error: Error) => {
      logger.warn(`profile in ${dir} not writable, ${base} answers 503: ${error.message}`);
      return false;
    },
  );

  // Answer: u32 LE length of the header, header (JSON), contents of all files in a row
  async function open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No simple cross-site request (the server never answers CORS)
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415);
    const device = field(await receiveJSON(req), 'device');
    const { header, contents } = await serial(async () => {
      profile.session = `${profile.id}.${crypto.randomUUID()}`;
      profile.device = typeof device === 'string' ? device.slice(0, 100) : '';
      profile.opened = Date.now();
      await saveProfile();
      const files: { path: string; size: number }[] = [];
      const contents: Buffer[] = [];
      for (const file of await listFiles()) {
        const data = await fs.readFile(path.join(filesDir, file.path));
        files.push({ path: file.path, size: data.length });
        contents.push(data);
      }
      const prefs: Record<string, unknown> = {};
      for (const name of await prefNames()) prefs[name] = await readJSON(prefFile(name));
      return {
        header: {
          id: profile.id,
          session: profile.session,
          created: profile.created,
          prefs,
          files,
        },
        contents,
      };
    });
    const head = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(head.length);
    const parts = [length, head, ...contents];
    const headers = {
      ...securityHeaders(),
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      Vary: 'Accept-Encoding',
    };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      pipeline(Readable.from(parts), zlib.createGzip(), res, () => {});
    } else {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      res.writeHead(200, { ...headers, 'Content-Length': total });
      pipeline(Readable.from(parts), res, () => {});
    }
  }

  async function putFile(req: IncomingMessage, res: ServerResponse, rel: string): Promise<void> {
    checkSession(req);
    const tmp = tmpFile();
    let stored = false;
    try {
      const handle = await fs.open(tmp, 'wx');
      let size: number;
      try {
        size = await receive(req, FILE_LIMIT, (chunk) => handle.write(chunk));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await serial(async () => {
        checkSession(req);
        const target = path.join(filesDir, rel);
        const old = await fileSize(target);
        if (bytes - old + size > maxBytes) throw new HttpError(507);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(tmp, target);
        stored = true;
        bytes += size - old;
        await changed();
      });
    } finally {
      if (!stored) await fs.rm(tmp, { force: true });
    }
    send(res, 204);
  }

  async function deleteFile(req: IncomingMessage, res: ServerResponse, rel: string): Promise<void> {
    await serial(async () => {
      checkSession(req);
      const target = path.join(filesDir, rel);
      const old = await fileSize(target);
      await fs.rm(target, { force: true });
      bytes -= old;
      // Remove directories that became empty
      for (let parent = path.dirname(target); parent !== filesDir; parent = path.dirname(parent)) {
        try {
          await fs.rmdir(parent);
        } catch {
          break;
        }
      }
      await changed();
    });
    send(res, 204);
  }

  async function prefNames(): Promise<string[]> {
    return (await fs.readdir(prefsDir))
      .filter((file) => file.endsWith('.json') && PREF_NAME.test(file.slice(0, -5)))
      .map((file) => file.slice(0, -5))
      .sort();
  }

  // Prefs share their own limits (count and total size), apart from maxBytes of the files
  async function putPrefs(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    checkSession(req);
    const data = JSON.stringify(await receiveJSON(req));
    await serial(async () => {
      checkSession(req);
      const names = await prefNames();
      if (!names.includes(name) && names.length >= PREF_COUNT) throw new HttpError(507);
      let total = Buffer.byteLength(data);
      for (const other of names) if (other !== name) total += await fileSize(prefFile(other));
      if (total > PREFS_LIMIT) throw new HttpError(507);
      await writeAtomic(prefFile(name), data);
      await changed();
    });
    send(res, 204);
  }

  // New id, the session of the caller stays active. all: every pref, else the listed ones
  async function reset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkSession(req);
    const body = await receiveJSON(req);
    const all = field(body, 'all') === true;
    const listed = field(body, 'prefs') ?? [];
    if (
      !Array.isArray(listed) ||
      !listed.every((name) => typeof name === 'string' && PREF_NAME.test(name))
    )
      throw new HttpError(400);
    await serial(async () => {
      checkSession(req);
      const old = tmpFile();
      await fs.rename(filesDir, old);
      await fs.mkdir(filesDir);
      for (const name of all ? await prefNames() : (listed as string[]))
        await fs.rm(prefFile(name), { force: true });
      bytes = 0;
      Object.assign(profile, fresh(), { resetBy: profile.session ?? undefined });
      await saveProfile();
      await fs.rm(old, { recursive: true, force: true });
    });
    send(res, 204);
  }

  // Cookies per domain from cookies.db, null without node:sqlite. immutable: SQLite creates no
  // -shm/-wal (WebKit uses WAL). The file comes from the client, so only a real table Cookie (no
  // view) and no code from the schema.
  async function cookieCounts(): Promise<
    { domain: string; count: number; session: number }[] | null
  > {
    sqlite ??= await import('node:sqlite').catch(() => false as const);
    if (!sqlite) return null;
    const file = path.join(filesDir, 'cookies.db');
    if (!(await fileSize(file))) return [];
    let db: InstanceType<SqliteModule['DatabaseSync']> | undefined;
    try {
      const url = pathToFileURL(file);
      url.search = '?immutable=1';
      db = new sqlite.DatabaseSync(url, { readOnly: true });
      db.exec('PRAGMA trusted_schema=OFF');
      const schema = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'Cookie'").get();
      if (schema?.type !== 'table') return null;
      return db
        .prepare(
          'SELECT domain, count(*) AS count, sum(session) AS session FROM Cookie GROUP BY domain',
        )
        .all()
        .map((row) => ({
          domain: String(row.domain),
          count: Number(row.count),
          session: Number(row.session),
        }));
    } catch (error) {
      logger.warn('profile: cookies.db not readable:', (error as Error).message);
      return null;
    } finally {
      db?.close();
    }
  }

  async function info(res: ServerResponse): Promise<void> {
    const { files, cookies } = await serial(async () => ({
      files: await listFiles(),
      cookies: await cookieCounts(),
    }));
    const { id, created, updated, device, opened } = profile;
    send(res, 200, { id, created, updated, device, opened, maxBytes, bytes, files, cookies });
  }

  async function respond(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: string,
  ): Promise<void> {
    if (!hostAllowed(req.headers.host) || !(await authorize(req, url))) throw new HttpError(403);
    if (!(await ready)) throw new HttpError(503);
    const method = req.method;
    if (route === 'open' && method === 'POST') return open(req, res);
    if (route === 'info' && method === 'GET') return info(res);
    if (route === 'reset' && method === 'POST') return reset(req, res);
    if (route.startsWith('files/') && (method === 'PUT' || method === 'DELETE')) {
      const rel = route.slice('files/'.length);
      if (!validPath(rel)) throw new HttpError(400);
      return method === 'PUT' ? putFile(req, res, rel) : deleteFile(req, res, rel);
    }
    if (route.startsWith('prefs/') && method === 'PUT') {
      const name = route.slice('prefs/'.length);
      if (!PREF_NAME.test(name)) throw new HttpError(400);
      return putPrefs(req, res, name);
    }
    throw new HttpError(404);
  }

  return {
    async handle(req, res) {
      let url: URL;
      let route: string;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
        route = decodeURIComponent(url.pathname);
      } catch {
        return false;
      }
      if (!route.startsWith(base)) return false;
      try {
        await respond(req, res, url, route.slice(base.length));
      } catch (caught) {
        let error = caught;
        if (!(error instanceof HttpError)) {
          const status = ERROR_STATUS[errorCode(error) ?? ''];
          if (!status) logger.error('profile:', error);
          error = new HttpError(status ?? 500);
        }
        const { status, body } = error as HttpError;
        if (res.headersSent) {
          res.destroy();
        } else {
          if (status === 413) await drain(req);
          send(res, status, body);
        }
      }
      return true;
    },
    async close() {
      await ready;
      await queue;
    },
  };
}
