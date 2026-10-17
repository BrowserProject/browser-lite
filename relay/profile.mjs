// Das Browser-Profil auf dem Server (Cookies, localStorage, kleine IndexedDBs, prefs der
// Oberflaeche), damit man auf Websites angemeldet bleibt, auch auf einem anderen Geraet.
// Genutzt von relay/server.mjs und web/serve.mjs, die API steht in relay/README.md.
//
// Unter dir: profile.json (id, aktive Session), files/<pfad> (Pfade wie in /data der Engine),
// prefs/<name>.json und tmp/ zum atomaren Schreiben (Datei schreiben, fsync, rename).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { SECURITY_HEADERS } from './static.mjs';

const MB = 1024 * 1024;
const FILE_LIMIT = 32 * MB;
const JSON_LIMIT = MB;
const PREFS = ['settings', 'bookmarks', 'permissions'];
// Fehler, die keine Fehler des Servers sind (Dateisystem, abgebrochener Upload)
const ERROR_STATUS = { ENOTDIR: 400, EISDIR: 400, EEXIST: 400, ENOSPC: 507, EROFS: 503, EACCES: 503, EPERM: 503, ECONNRESET: 400 };

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function validName(name) {
  return name !== '' && !name.startsWith('.') && !/[/\\\0]/.test(name) && Buffer.byteLength(name) <= 255;
}

// Nur die Dateien, die ins Profil gehoeren
function validPath(rel) {
  const parts = rel.split('/');
  if (!parts.every(validName))
    return false;
  if (parts.length === 1)
    return parts[0] === 'cookies.db';
  if (parts[0] === 'localstorage')
    return parts.length === 2 && parts[1].endsWith('.localstorage');
  return parts[0] === 'indexeddb' && parts[1] === 'v1' && (parts.length === 5 || parts.length === 6);
}

// Gegen DNS-Rebinding: nur IP-Adressen, localhost und die Namen aus hosts (".ts.net" passt
// auf alle Namen, die so enden, sonst nur genau der Name)
function hostAllowed(header, hosts) {
  const host = (header || '').toLowerCase();
  const ipv6 = /^\[(.*)\](?::\d*)?$/.exec(host);
  if (ipv6)
    return net.isIPv6(ipv6[1]);
  const name = host.replace(/:\d*$/, '');
  return net.isIPv4(name) || name === 'localhost'
    || hosts.some((entry) => (entry.startsWith('.') ? name.endsWith(entry) : name === entry));
}

function send(res, status, body) {
  const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
  // Der Rest des Bodys wird nicht mehr gelesen
  if (status === 413)
    headers.Connection = 'close';
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// Gibt den Body stueckweise an write, hoechstens limit Bytes (sonst 413). destroyOnReturn: false
// laesst die Verbindung offen, damit die Antwort noch ankommt.
async function receive(req, limit, write) {
  if (Number(req.headers['content-length']) > limit)
    throw new HttpError(413);
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413);
    await write(chunk);
  }
  return size;
}

async function receiveJSON(req) {
  const parts = [];
  await receive(req, JSON_LIMIT, (chunk) => parts.push(chunk));
  try {
    return JSON.parse(Buffer.concat(parts).toString() || 'null');
  } catch {
    throw new HttpError(400);
  }
}

// JSON-Datei, null wenn sie fehlt oder kaputt ist
async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

// Groesse einer Datei, 0 wenn es sie nicht gibt
async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile())
      throw new HttpError(400);
    return stat.size;
  } catch (error) {
    if (error.code === 'ENOENT')
      return 0;
    throw error;
  }
}

let sqlite; // node:sqlite, false wenn es das nicht gibt

// hosts: weitere erlaubte Namen, mit Komma getrennt (PROFILE_HOSTS)
export function createProfileHandler({ dir, authorize = () => true, hosts = '', maxBytes = Number(process.env.PROFILE_MAX_MB || 64) * MB }) {
  const allowedHosts = hosts.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const filesDir = path.join(dir, 'files');
  const prefsDir = path.join(dir, 'prefs');
  const tmpDir = path.join(dir, 'tmp');
  const profileFile = path.join(dir, 'profile.json');
  const prefFile = (name) => path.join(prefsDir, `${name}.json`);
  const tmpFile = () => path.join(tmpDir, crypto.randomUUID());
  let profile = null;
  let bytes = 0;

  // Alles, was files/ oder profile.json anfasst, laeuft nacheinander
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  async function writeAtomic(file, data) {
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

  // Andere Dateien in files/ gehoeren nicht zum Profil und werden nie verschickt
  async function listFiles() {
    const files = [];
    for (const entry of await fs.readdir(filesDir, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      const rel = path.relative(filesDir, file).split(path.sep).join('/');
      if (!entry.isFile() || !validPath(rel))
        continue;
      const stat = await fs.stat(file);
      files.push({ path: rel, size: stat.size, modified: Math.round(stat.mtimeMs) });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // Eine Session beginnt mit der Profil-id beim Oeffnen: so sieht man, ob eine alte Session zu
  // einem zurueckgesetzten Profil gehoert. Die Session, die zurueckgesetzt hat (resetBy),
  // gehoert zum neuen.
  function checkSession(req) {
    const session = req.headers['x-profile-session'];
    if (!session)
      throw new HttpError(400);
    if (session !== profile.session) {
      const current = session.startsWith(`${profile.id}.`) || session === profile.resetBy;
      throw new HttpError(409, { reason: current ? 'taken' : 'reset' });
    }
  }

  async function init() {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const sub of [filesDir, prefsDir, tmpDir])
      await fs.mkdir(sub, { recursive: true });
    profile = await readJSON(profileFile) || { ...fresh(), session: null, device: null, opened: null };
    await saveProfile();
    bytes = (await listFiles()).reduce((sum, file) => sum + file.size, 0);
  }
  const ready = init().then(() => true, (error) => {
    console.warn(`Profil in ${dir} nicht schreibbar, /profile/ antwortet 503: ${error.message}`);
    return false;
  });

  // Antwort: u32 LE Laenge des Kopfes, Kopf (JSON), Inhalte aller Dateien hintereinander
  async function open(req, res) {
    // Kein einfacher Cross-Site-Request (CORS beantwortet der Server nie)
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new HttpError(415);
    const device = (await receiveJSON(req))?.device;
    const { header, contents } = await serial(async () => {
      profile.session = `${profile.id}.${crypto.randomUUID()}`;
      profile.device = typeof device === 'string' ? device.slice(0, 100) : '';
      profile.opened = Date.now();
      await saveProfile();
      const files = [];
      const contents = [];
      for (const file of await listFiles()) {
        const data = await fs.readFile(path.join(filesDir, file.path));
        files.push({ path: file.path, size: data.length });
        contents.push(data);
      }
      const prefs = {};
      for (const name of PREFS)
        prefs[name] = await readJSON(prefFile(name));
      return { header: { id: profile.id, session: profile.session, created: profile.created, prefs, files }, contents };
    });
    const head = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(head.length);
    const parts = [length, head, ...contents];
    const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Vary': 'Accept-Encoding' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      pipeline(Readable.from(parts), zlib.createGzip(), res, () => {});
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': parts.reduce((sum, part) => sum + part.length, 0) });
      pipeline(Readable.from(parts), res, () => {});
    }
  }

  async function putFile(req, res, rel) {
    checkSession(req);
    const tmp = tmpFile();
    let stored = false;
    try {
      const handle = await fs.open(tmp, 'wx');
      let size;
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
        if (bytes - old + size > maxBytes)
          throw new HttpError(507);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(tmp, target);
        stored = true;
        bytes += size - old;
        await changed();
      });
    } finally {
      if (!stored)
        await fs.rm(tmp, { force: true });
    }
    send(res, 204);
  }

  async function deleteFile(req, res, rel) {
    await serial(async () => {
      checkSession(req);
      const target = path.join(filesDir, rel);
      const old = await fileSize(target);
      await fs.rm(target, { force: true });
      bytes -= old;
      // Leere Ordner mit aufraeumen
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

  async function putPrefs(req, res, name) {
    checkSession(req);
    const value = await receiveJSON(req);
    await serial(async () => {
      checkSession(req);
      await writeAtomic(prefFile(name), JSON.stringify(value));
      await changed();
    });
    send(res, 204);
  }

  // Neue id, die Session des Aufrufers bleibt aktiv
  async function reset(req, res) {
    checkSession(req);
    const all = (await receiveJSON(req))?.all === true;
    await serial(async () => {
      checkSession(req);
      const old = tmpFile();
      await fs.rename(filesDir, old);
      await fs.mkdir(filesDir);
      for (const name of all ? PREFS : ['permissions'])
        await fs.rm(prefFile(name), { force: true });
      bytes = 0;
      Object.assign(profile, fresh(), { resetBy: profile.session });
      await saveProfile();
      await fs.rm(old, { recursive: true, force: true });
    });
    send(res, 204);
  }

  // Cookies pro Domain aus cookies.db, null ohne node:sqlite. immutable: SQLite legt kein
  // -shm/-wal an (WebKit nutzt WAL). Die Datei kommt vom Client, darum nur eine echte Tabelle
  // Cookie (keine View) und kein Code aus dem Schema.
  async function cookieCounts() {
    sqlite ??= await import('node:sqlite').catch(() => false);
    if (!sqlite)
      return null;
    const file = path.join(filesDir, 'cookies.db');
    if (!await fileSize(file))
      return [];
    let db;
    try {
      const url = pathToFileURL(file);
      url.search = '?immutable=1';
      db = new sqlite.DatabaseSync(url, { readOnly: true });
      db.exec('PRAGMA trusted_schema=OFF');
      if (db.prepare("SELECT type FROM sqlite_schema WHERE name = 'Cookie'").get()?.type !== 'table')
        return null;
      return db.prepare('SELECT domain, count(*) AS count, sum(session) AS session FROM Cookie GROUP BY domain').all()
        .map((row) => ({ domain: row.domain, count: Number(row.count), session: Number(row.session) }));
    } catch (error) {
      console.warn('cookies.db nicht lesbar:', error.message);
      return null;
    } finally {
      db?.close();
    }
  }

  async function info(res) {
    const { files, cookies } = await serial(async () => ({ files: await listFiles(), cookies: await cookieCounts() }));
    const { id, created, updated, device, opened } = profile;
    send(res, 200, { id, created, updated, device, opened, maxBytes, bytes, files, cookies });
  }

  async function respond(req, res, route) {
    if (!hostAllowed(req.headers.host, allowedHosts) || !authorize(req))
      throw new HttpError(403);
    if (!await ready)
      throw new HttpError(503);
    const method = req.method;
    if (route === 'open' && method === 'POST')
      return open(req, res);
    if (route === 'info' && method === 'GET')
      return info(res);
    if (route === 'reset' && method === 'POST')
      return reset(req, res);
    if (route.startsWith('files/') && (method === 'PUT' || method === 'DELETE')) {
      const rel = route.slice('files/'.length);
      if (!validPath(rel))
        throw new HttpError(400);
      return method === 'PUT' ? putFile(req, res, rel) : deleteFile(req, res, rel);
    }
    if (route.startsWith('prefs/') && method === 'PUT') {
      const name = route.slice('prefs/'.length);
      if (!PREFS.includes(name))
        throw new HttpError(400);
      return putPrefs(req, res, name);
    }
    throw new HttpError(404);
  }

  // true, wenn die Anfrage unter /profile/ lag (dann ist sie beantwortet)
  return function handle(req, res, request) {
    if (!request.path.startsWith('/profile/'))
      return false;
    respond(req, res, request.path.slice('/profile/'.length)).catch((error) => {
      if (!(error instanceof HttpError)) {
        const status = ERROR_STATUS[error.code];
        if (!status)
          console.error('Profil:', error);
        error = new HttpError(status || 500);
      }
      if (res.headersSent)
        res.destroy();
      else
        send(res, error.status, error.body);
    });
    return true;
  };
}
