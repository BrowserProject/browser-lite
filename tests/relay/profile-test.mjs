// Testet das Profil auf dem Server (relay/profile.mjs in relay/server.mjs und web/serve.mjs):
// open (Format, gzip), Dateien und prefs schreiben und loeschen, Pfad-Pruefung, Grenzen,
// Token, Host (DNS-Rebinding), Content-Type von open, fremde Dateien in files/, Uebernahme
// durch ein anderes Geraet (409 taken), reset (409 reset, neue id), Neustart des Servers, nicht
// schreibbarer Ordner (503), cookies in /profile/info (WAL ohne -shm/-wal, View als Cookie).
//   node tests/relay/profile-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'test-token-0123456789abcdef';
const PORT = 15011;
const MB = 1024 * 1024;

setTimeout(() => {
  console.log('FAIL Zeitlimit (120 s)');
  process.exit(1);
}, 120000).unref();

const children = new Set();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-profile-test-'));
process.on('exit', () => {
  for (const child of children)
    child.kill('SIGKILL');
  fs.rmSync(temp, { recursive: true, force: true });
});

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};

// Server starten, fertig sobald er laeuft (false, wenn er vorher endet)
async function startServer(script, args, env) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, script), ...args], {
    env: { ...process.env, HOST: '127.0.0.1', RELAY_TOKEN: '', RELAY_ALLOW_LOCAL: '', PROFILE_DIR: '', PROFILE_MAX_MB: '', PROFILE_HOSTS: '', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.add(child);
  child.exited = new Promise((resolve) => child.on('exit', (code) => {
    children.delete(child);
    resolve(code);
  }));
  const ready = await new Promise((resolve) => {
    child.stdout.on('data', (d) => /laeuft|browser-lite auf/.test(d) && resolve(true));
    child.exited.then(() => resolve(false));
  });
  return ready ? child : null;
}
async function stopServer(child) {
  child.kill('SIGTERM');
  return child.exited;
}

function request(urlPath, { method = 'GET', headers = {}, body, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const json = (value) => Buffer.from(JSON.stringify(value));
const auth = { Authorization: `Bearer ${TOKEN}` };
const as = (session) => ({ ...auth, 'X-Profile-Session': session });

function parseBundle(data) {
  const length = data.readUInt32LE(0);
  const header = JSON.parse(data.subarray(4, 4 + length).toString());
  const files = {};
  let offset = 4 + length;
  for (const file of header.files) {
    files[file.path] = data.subarray(offset, offset + file.size);
    offset += file.size;
  }
  return { header, files, rest: data.length - offset };
}
async function open(device, headers = {}) {
  const res = await request('/profile/open', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...headers }, body: json({ device }) });
  const data = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body;
  return { ...res, ...(res.status === 200 ? parseBundle(data) : {}) };
}
const put = (session, file, body) => request(`/profile/files/${file}`, { method: 'PUT', headers: as(session), body });
const info = async () => JSON.parse((await request('/profile/info', { headers: auth })).body);
// Alle Dateien unter files/ auf der Platte
const diskFiles = () => fs.readdirSync(path.join(dir, 'files'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(path.join(dir, 'files'), path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));

// Schickt total Bytes ohne Content-Length: der Server muss beim Lesen aufhoeren
function streamUpload(session, file, total) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/profile/files/${file}`, method: 'PUT', headers: as(session), agent: false }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', (error) => resolve({ error: error.code }));
    const chunk = Buffer.alloc(MB);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

// cookies.db wie von WebKit (WAL, nur die Spalten, die info braucht) und eine boese, in der
// Cookie eine endlose View ist
let cookies = null;
let evilCookies = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const create = (name, sql) => {
    const file = path.join(temp, name);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(sql);
    db.close();
    return fs.readFileSync(file);
  };
  cookies = create('cookies.db', "CREATE TABLE Cookie (name TEXT, value TEXT, domain TEXT, session INTEGER); INSERT INTO Cookie VALUES ('a', '1', '.example.org', 0), ('b', '2', '.example.org', 1), ('c', '3', 'test.ch', 0)");
  evilCookies = create('evil.db', 'CREATE VIEW Cookie AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x AS domain, 1 AS session FROM r');
} catch {
  console.log('Hinweis: ohne node:sqlite, cookies in info nicht geprueft');
}

const dir = path.join(temp, 'profile');
const env = { RELAY_TOKEN: TOKEN, PORT: String(PORT), PROFILE_DIR: dir, PROFILE_MAX_MB: '1', PROFILE_HOSTS: ' .ts.net, Profil.LAN ' };
let server = await startServer('relay/server.mjs', [], env);
check('Server mit Profil startet', Boolean(server));

// ---------------------------------------------------------------- Token
check('ohne Token 403', (await request('/profile/info')).status === 403);
check('falscher Token 403', (await request('/profile/info', { headers: { Authorization: 'Bearer falsch' } })).status === 403);
const first = await request('/profile/info', { headers: auth });
check('mit Token 200, no-store, COEP', first.status === 200 && first.headers['cache-control'] === 'no-store'
  && first.headers['cross-origin-embedder-policy'] === 'require-corp');
check('unbekannter Pfad 404', (await request('/profile/fehlt', { headers: auth })).status === 404);

// ---------------------------------------------------------------- Host, Content-Type
for (const [host, status] of [['localhost:15011', 200], ['LOCALHOST', 200], ['127.0.0.1', 200], ['[::1]:15011', 200],
  ['browser.tail1234.ts.net', 200], ['Browser.Tail1234.TS.NET:443', 200], ['profil.lan', 200], ['ts.net', 403],
  ['x.profil.lan', 403], ['ts.net.boese.example', 403], ['boese.example', 403], ['[localhost]', 403]])
  check(`Host "${host}" ${status}`, (await request('/profile/info', { headers: { ...auth, Host: host } })).status === status);
check('falscher Host auch fuer open 403', (await open('x', { Host: 'boese.example' })).status === 403);
check('open ohne Content-Type 415', (await open('x', { 'Content-Type': '' })).status === 415);
check('open als text/plain 415', (await open('x', { 'Content-Type': 'text/plain' })).status === 415);

// ---------------------------------------------------------------- open, schreiben
const a = await open('Chrome auf Linux');
const { prefs } = a.header;
check('open: leeres Profil', a.status === 200 && a.header.files.length === 0 && a.rest === 0
  && prefs.settings === null && prefs.bookmarks === null && prefs.permissions === null && Boolean(a.header.id)
  && a.headers['content-type'] === 'application/octet-stream', JSON.stringify(a.header));
const sessionA = a.header.session;

const files = {
  'localstorage/https_example.org_0.localstorage': Buffer.from('localstorage'),
  'indexeddb/v1/top/name/IndexedDB.sqlite3': Buffer.from('idb'),
  'indexeddb/v1/top/client/name/1.blob': crypto.getRandomValues(Buffer.alloc(1000)),
};
if (cookies)
  files['cookies.db'] = cookies;
const puts = [];
for (const [file, data] of Object.entries(files))
  puts.push((await put(sessionA, file, data)).status);
check('PUT Dateien 204', puts.every((status) => status === 204), puts.join());
check('PUT ohne Session 400', (await request('/profile/files/cookies.db', { method: 'PUT', headers: auth, body: 'x' })).status === 400);
const prefsStatus = [];
for (const name of ['settings', 'bookmarks', 'permissions'])
  prefsStatus.push((await request(`/profile/prefs/${name}`, { method: 'PUT', headers: as(sessionA), body: json({ name }) })).status);
check('PUT prefs 204', prefsStatus.every((status) => status === 204), prefsStatus.join());
check('PUT prefs unbekannt 400', (await request('/profile/prefs/verlauf', { method: 'PUT', headers: as(sessionA), body: '{}' })).status === 400);
check('PUT prefs kaputtes JSON 400', (await request('/profile/prefs/settings', { method: 'PUT', headers: as(sessionA), body: '{x' })).status === 400);
check('PUT prefs ueber 1 MB 413', (await request('/profile/prefs/settings', { method: 'PUT', headers: as(sessionA), body: json('x'.repeat(MB)) })).status === 413);

{
  const state = await info();
  const total = Object.values(files).reduce((sum, data) => sum + data.length, 0);
  check('info: Dateien und Groesse', state.files.length === Object.keys(files).length && state.bytes === total
    && state.maxBytes === MB && state.device === 'Chrome auf Linux' && state.files.every((file) => file.modified > 0), JSON.stringify(state));
  check('info: in files/ nur Dateien des Profils (kein -shm/-wal)', diskFiles().sort().join() === Object.keys(files).sort().join(), diskFiles().join());
  if (cookies) {
    const domains = Object.fromEntries((state.cookies || []).map((row) => [row.domain, row]));
    check('info: Cookies pro Domain', domains['.example.org']?.count === 2 && domains['.example.org']?.session === 1
      && domains['test.ch']?.count === 1, JSON.stringify(state.cookies));
  }
}

// ---------------------------------------------------------------- Pfade und Grenzen
for (const bad of ['..%2f..%2fetc%2fpasswd', '%2fetc%2fpasswd', 'localstorage/LegacyStorageTracker.db', 'opfs/a',
  'cachestorage/x', 'indexeddb/v1/top/name', 'indexeddb/v1/top/.name/x', 'indexeddb/v1/top/..%2fname/x',
  'indexeddb/v1/top/a%5cb/x', 'indexeddb/v1/top/a/b/c/d', 'localstorage/.localstorage', 'cookies.db-journal',
  `indexeddb/v1/top/${'n'.repeat(256)}/x`])
  check(`Pfad ${bad.slice(0, 40)} 400`, (await put(sessionA, bad, 'x')).status === 400);
check('Content-Length ueber 32 MB 413', (await request('/profile/files/cookies.db', { method: 'PUT', headers: { ...as(sessionA), 'Content-Length': String(33 * MB) } })).status === 413);
{
  const result = await streamUpload(sessionA, 'indexeddb/v1/top/gross/IndexedDB.sqlite3', 33 * MB);
  check('Body ueber 32 MB beim Lesen abgebrochen', result.status === 413 || result.error === 'ECONNRESET' || result.error === 'EPIPE', JSON.stringify(result));
  const state = await info();
  check('davon nichts gespeichert, tmp leer', !state.files.some((file) => file.path.includes('gross'))
    && fs.readdirSync(path.join(dir, 'tmp')).length === 0, fs.readdirSync(path.join(dir, 'tmp')).join());
}
{
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/profile/files/indexeddb/v1/top/halb/IndexedDB.sqlite3', method: 'PUT',
    headers: { ...as(sessionA), 'Content-Length': '100000' }, agent: false });
  req.on('error', () => {});
  req.write(Buffer.alloc(50000));
  await new Promise((resolve) => setTimeout(resolve, 200));
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = await info();
  check('abgebrochener Upload speichert nichts', !state.files.some((file) => file.path.includes('halb'))
    && fs.readdirSync(path.join(dir, 'tmp')).length === 0);
}
{
  const half = Buffer.alloc(600 * 1024);
  check('erste grosse Datei passt', (await put(sessionA, 'indexeddb/v1/top/voll/IndexedDB.sqlite3', half)).status === 204);
  check('Profil voll 507', (await put(sessionA, 'indexeddb/v1/top/voll/1.blob', half)).status === 507);
  check('Ersetzen zaehlt die alte Groesse nicht', (await put(sessionA, 'indexeddb/v1/top/voll/IndexedDB.sqlite3', half)).status === 204);
  check('DELETE 204', (await request('/profile/files/indexeddb/v1/top/voll/IndexedDB.sqlite3', { method: 'DELETE', headers: as(sessionA) })).status === 204);
  check('DELETE schon weg 204', (await request('/profile/files/indexeddb/v1/top/voll/IndexedDB.sqlite3', { method: 'DELETE', headers: as(sessionA) })).status === 204);
  check('leere Ordner aufgeraeumt', !fs.existsSync(path.join(dir, 'files', 'indexeddb', 'v1', 'top', 'voll'))
    && fs.existsSync(path.join(dir, 'files', 'indexeddb', 'v1', 'top', 'name')));
}

// ---------------------------------------------------------------- Fremde Dateien, Uebernahme, gzip
const strays = ['cookies.db-wal', 'fremd.txt', 'localstorage/.versteckt.localstorage', 'opfs/a'];
for (const stray of strays) {
  fs.mkdirSync(path.dirname(path.join(dir, 'files', stray)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', stray), 'fremd');
}
const b = await open('Safari auf iPad', { 'Accept-Encoding': 'gzip', 'Content-Type': 'application/json; charset=utf-8' });
const sessionB = b.header.session;
check('open mit gzip', b.headers['content-encoding'] === 'gzip' && b.rest === 0);
check('open: alle Dateien mit Inhalt', Object.entries(files).every(([file, data]) => b.files[file]?.equals(data))
  && b.header.files.length === Object.keys(files).length, b.header.files.map((file) => file.path).join());
check('open: prefs', b.header.prefs.settings?.name === 'settings' && b.header.prefs.bookmarks?.name === 'bookmarks'
  && b.header.prefs.permissions?.name === 'permissions' && b.header.id === a.header.id && sessionB !== sessionA);
{
  const res = await put(sessionA, 'cookies.db', 'alt');
  check('alte Session: 409 taken', res.status === 409 && JSON.parse(res.body).reason === 'taken', res.body.toString());
  const del = await request('/profile/files/cookies.db', { method: 'DELETE', headers: as(sessionA) });
  check('alte Session loescht nicht: 409', del.status === 409);
}
check('neue Session schreibt', (await put(sessionB, 'localstorage/https_neu.ch_0.localstorage', 'neu')).status === 204);

// ---------------------------------------------------------------- Neustart
check('SIGTERM beendet sauber', await stopServer(server) === 0);
server = await startServer('relay/server.mjs', [], env);
{
  const state = await info();
  check('nach Neustart: Daten da', state.id === a.header.id && state.files.some((file) => file.path === 'localstorage/https_neu.ch_0.localstorage'));
  check('fremde Dateien nicht gezaehlt', !state.files.some((file) => strays.includes(file.path))
    && state.bytes === state.files.reduce((sum, file) => sum + file.size, 0), JSON.stringify(state.files));
  check('nach Neustart: Session gilt weiter', (await put(sessionB, 'localstorage/https_neu.ch_0.localstorage', 'neu2')).status === 204);
  const res = await put(sessionA, 'cookies.db', 'alt');
  check('nach Neustart: alte Session 409 taken', res.status === 409 && JSON.parse(res.body).reason === 'taken');
}

// ---------------------------------------------------------------- reset
{
  const res = await request('/profile/reset', { method: 'POST', headers: as(sessionB), body: json({ all: false }) });
  check('reset 204', res.status === 204);
  const state = await info();
  check('reset: neue id, keine Dateien', state.id !== a.header.id && state.files.length === 0 && state.bytes === 0, JSON.stringify(state));
  const old = await put(sessionA, 'cookies.db', 'alt');
  check('vor dem reset geoeffnet: 409 reset', old.status === 409 && JSON.parse(old.body).reason === 'reset', old.body.toString());
  check('Session des Aufrufers bleibt aktiv', (await put(sessionB, 'cookies.db', 'x')).status === 204);
  const c = await open('Chrome auf Linux');
  check('reset ohne all: settings und bookmarks bleiben', c.header.prefs.settings?.name === 'settings'
    && c.header.prefs.bookmarks?.name === 'bookmarks' && c.header.prefs.permissions === null && c.header.id === state.id);
  const taken = await put(sessionB, 'cookies.db', 'y');
  check('danach anderes Geraet: 409 taken', taken.status === 409 && JSON.parse(taken.body).reason === 'taken');
  check('reset mit alter Session 409', (await request('/profile/reset', { method: 'POST', headers: as(sessionB), body: '{}' })).status === 409);
  check('reset all 204', (await request('/profile/reset', { method: 'POST', headers: as(c.header.session), body: json({ all: true }) })).status === 204);
  const d = await open('Chrome auf Linux');
  check('reset all: alles weg', d.header.files.length === 0 && Object.values(d.header.prefs).every((value) => value === null), JSON.stringify(d.header.prefs));
  if (evilCookies) {
    check('boese cookies.db hochgeladen', (await put(d.header.session, 'cookies.db', evilCookies)).status === 204);
    const start = Date.now();
    const res = await request('/profile/info', { headers: auth });
    check('Cookie als View: cookies null, schnell', res.status === 200 && JSON.parse(res.body).cookies === null
      && Date.now() - start < 2000, `${res.status} ${Date.now() - start} ms`);
  }
}
await stopServer(server);

// ---------------------------------------------------------------- nicht schreibbar, ohne Profil
{
  fs.writeFileSync(path.join(temp, 'datei'), '');
  const broken = await startServer('relay/server.mjs', [], { PORT: String(PORT), PROFILE_DIR: path.join(temp, 'datei', 'profil') });
  check('nicht schreibbar: Server startet', Boolean(broken));
  check('nicht schreibbar: 503', (await request('/profile/info')).status === 503);
  check('nicht schreibbar: Server laeuft', (await request('/healthz')).status === 200);
  await stopServer(broken);

  const plain = await startServer('relay/server.mjs', [], { PORT: String(PORT) });
  check('ohne PROFILE_DIR: 404', (await request('/profile/info')).status === 404);
  await stopServer(plain);
}

// ---------------------------------------------------------------- Entwicklungs-Server
{
  const dev = await startServer('web/serve.mjs', [String(PORT)], { PROFILE_DIR: path.join(temp, 'dev'), PROFILE_HOSTS: 'dev.test' });
  const res = await request('/profile/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('web/serve.mjs mit PROFILE_DIR', res.status === 200 && parseBundle(res.body).header.files.length === 0);
  check('web/serve.mjs mit PROFILE_HOSTS', (await request('/profile/info', { headers: { Host: 'dev.test:8080' } })).status === 200
    && (await request('/profile/info', { headers: { Host: 'boese.example' } })).status === 403);
  await stopServer(dev);
  const plain = await startServer('web/serve.mjs', [String(PORT)], {});
  check('web/serve.mjs ohne PROFILE_DIR: 404', (await request('/profile/info')).status === 404);
  await stopServer(plain);
}

console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
