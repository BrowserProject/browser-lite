// Profile store through the CLI: open (format, gzip), writing and deleting files and prefs, path
// rules, limits, token, Host (DNS rebinding), Content-Type of open, foreign files in files/,
// takeover by another device (409 taken), reset (409 reset, new id), server restart, directory
// not writable (503), cookies in /profile/info (WAL without -shm/-wal, a view as Cookie). Options
// of createProfileStore: authorize required, own path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { createProfileStore } from '../dist/index.js';
import { request as httpRequest, startCli, stopCli } from './helpers.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const MB = 1024 * 1024;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-profile-test-'));
const dir = path.join(temp, 'profile');
const env = {
  RELAY_TOKEN: TOKEN,
  PROFILE_DIR: dir,
  PROFILE_MAX_MB: '1',
  ALLOWED_HOSTS: ' .ts.net, Profil.LAN ',
};
let server = await startCli(env);
after(async () => {
  if (server?.ready) await stopCli(server);
  fs.rmSync(temp, { recursive: true, force: true });
});

const request = (urlPath, options) => httpRequest(server.port, urlPath, options);
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
  const res = await request('/profile/open', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', ...headers },
    body: json({ device }),
  });
  const data = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body;
  return { ...res, ...(res.status === 200 ? parseBundle(data) : {}) };
}
const put = (session, file, body) =>
  request(`/profile/files/${file}`, { method: 'PUT', headers: as(session), body });
const info = async () => JSON.parse((await request('/profile/info', { headers: auth })).body);
// All files under files/ on disk
const diskFiles = () =>
  fs
    .readdirSync(path.join(dir, 'files'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(path.join(dir, 'files'), path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    );

// Sends total bytes without Content-Length: the server must stop while reading
function streamUpload(session, file, total) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: `/profile/files/${file}`,
        method: 'PUT',
        headers: as(session),
        agent: false,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      },
    );
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

// cookies.db like WebKit's (WAL, only the columns info needs) and an evil one where Cookie is an
// endless view
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
  cookies = create(
    'cookies.db',
    "CREATE TABLE Cookie (name TEXT, value TEXT, domain TEXT, session INTEGER); INSERT INTO Cookie VALUES ('a', '1', '.example.org', 0), ('b', '2', '.example.org', 1), ('c', '3', 'test.ch', 0)",
  );
  evilCookies = create(
    'evil.db',
    'CREATE VIEW Cookie AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x AS domain, 1 AS session FROM r',
  );
} catch {
  // Without node:sqlite the cookie counts are not checked
}

const files = {
  'localstorage/https_example.org_0.localstorage': Buffer.from('localstorage'),
  'indexeddb/v1/top/name/IndexedDB.sqlite3': Buffer.from('idb'),
  'indexeddb/v1/top/client/name/1.blob': crypto.getRandomValues(Buffer.alloc(1000)),
};
if (cookies) files['cookies.db'] = cookies;
let first;
let sessionA;
let sessionB;
const strays = ['cookies.db-wal', 'foreign.txt', 'localstorage/.hidden.localstorage', 'opfs/a'];

test('server with profile starts', () => {
  assert.ok(server.ready, server.log);
});

test('token', async () => {
  assert.equal((await request('/profile/info')).status, 403);
  assert.equal(
    (await request('/profile/info', { headers: { Authorization: 'Bearer wrong' } })).status,
    403,
  );
  const res = await request('/profile/info', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal((await request('/profile/missing', { headers: auth })).status, 404);
});

test('Host and Content-Type', async () => {
  for (const [host, status] of [
    ['localhost:15011', 200],
    ['LOCALHOST', 200],
    ['127.0.0.1', 200],
    ['[::1]:15011', 200],
    ['browser.tail1234.ts.net', 200],
    ['Browser.Tail1234.TS.NET:443', 200],
    ['profil.lan', 200],
    ['ts.net', 403],
    ['x.profil.lan', 403],
    ['ts.net.evil.example', 403],
    ['evil.example', 403],
    ['[localhost]', 403],
  ])
    assert.equal(
      (await request('/profile/info', { headers: { ...auth, Host: host } })).status,
      status,
      host,
    );
  assert.equal((await open('x', { Host: 'evil.example' })).status, 403);
  assert.equal((await open('x', { 'Content-Type': '' })).status, 415);
  assert.equal((await open('x', { 'Content-Type': 'text/plain' })).status, 415);
});

test('open and write', async () => {
  first = await open('Chrome on Linux');
  const { prefs } = first.header;
  assert.equal(first.status, 200);
  assert.equal(first.header.files.length, 0);
  assert.equal(first.rest, 0);
  assert.deepEqual(prefs, {});
  assert.ok(first.header.id);
  assert.equal(first.headers['content-type'], 'application/octet-stream');
  sessionA = first.header.session;

  for (const [file, data] of Object.entries(files))
    assert.equal((await put(sessionA, file, data)).status, 204, file);
  assert.equal(
    (await request('/profile/files/cookies.db', { method: 'PUT', headers: auth, body: 'x' }))
      .status,
    400,
    'PUT without session',
  );
  for (const name of ['settings', 'bookmarks', 'permissions']) {
    const res = await request(`/profile/prefs/${name}`, {
      method: 'PUT',
      headers: as(sessionA),
      body: json({ name }),
    });
    assert.equal(res.status, 204, name);
  }
  const prefsPut = (name, body) =>
    request(`/profile/prefs/${name}`, { method: 'PUT', headers: as(sessionA), body });
  assert.equal((await prefsPut('history', '{}')).status, 204, 'any well-formed name');
  for (const bad of ['History', '1st', 'a.b', 'a_b', 'x'.repeat(33), 'a%2Fb'])
    assert.equal((await prefsPut(bad, '{}')).status, 400, bad);
  assert.equal((await prefsPut('settings', '{x')).status, 400);
  assert.equal((await prefsPut('settings', json('x'.repeat(MB)))).status, 413);

  const state = await info();
  const total = Object.values(files).reduce((sum, data) => sum + data.length, 0);
  assert.equal(state.files.length, Object.keys(files).length);
  assert.equal(state.bytes, total);
  assert.equal(state.maxBytes, MB);
  assert.equal(state.device, 'Chrome on Linux');
  assert.ok(state.files.every((file) => file.modified > 0));
  assert.equal(diskFiles().sort().join(), Object.keys(files).sort().join(), 'no -shm/-wal');
  if (cookies) {
    const domains = Object.fromEntries((state.cookies ?? []).map((row) => [row.domain, row]));
    assert.equal(domains['.example.org']?.count, 2);
    assert.equal(domains['.example.org']?.session, 1);
    assert.equal(domains['test.ch']?.count, 1);
  }
});

test('paths and limits', async () => {
  for (const bad of [
    '..%2f..%2fetc%2fpasswd',
    '%2fetc%2fpasswd',
    'localstorage/LegacyStorageTracker.db',
    'opfs/a',
    'cachestorage/x',
    'indexeddb/v1/top/name',
    'indexeddb/v1/top/.name/x',
    'indexeddb/v1/top/..%2fname/x',
    'indexeddb/v1/top/a%5cb/x',
    'indexeddb/v1/top/a/b/c/d',
    'localstorage/.localstorage',
    'cookies.db-journal',
    `indexeddb/v1/top/${'n'.repeat(256)}/x`,
  ])
    assert.equal((await put(sessionA, bad, 'x')).status, 400, bad.slice(0, 40));
  const tooLarge = await request('/profile/files/cookies.db', {
    method: 'PUT',
    headers: { ...as(sessionA), 'Content-Length': String(33 * MB) },
  });
  assert.equal(tooLarge.status, 413);

  const result = await streamUpload(sessionA, 'indexeddb/v1/top/large/IndexedDB.sqlite3', 33 * MB);
  assert.ok(
    result.status === 413 || result.error === 'ECONNRESET' || result.error === 'EPIPE',
    JSON.stringify(result),
  );
  let state = await info();
  assert.ok(!state.files.some((file) => file.path.includes('large')));
  assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0);

  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    path: '/profile/files/indexeddb/v1/top/half/IndexedDB.sqlite3',
    method: 'PUT',
    headers: { ...as(sessionA), 'Content-Length': '100000' },
    agent: false,
  });
  req.on('error', () => {});
  req.write(Buffer.alloc(50000));
  await new Promise((resolve) => setTimeout(resolve, 200));
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  state = await info();
  assert.ok(
    !state.files.some((file) => file.path.includes('half')),
    'aborted upload stores nothing',
  );
  assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0);

  const half = Buffer.alloc(600 * 1024);
  assert.equal((await put(sessionA, 'indexeddb/v1/top/full/IndexedDB.sqlite3', half)).status, 204);
  assert.equal((await put(sessionA, 'indexeddb/v1/top/full/1.blob', half)).status, 507);
  assert.equal(
    (await put(sessionA, 'indexeddb/v1/top/full/IndexedDB.sqlite3', half)).status,
    204,
    'replacing does not count the old size',
  );
  const del = () =>
    request('/profile/files/indexeddb/v1/top/full/IndexedDB.sqlite3', {
      method: 'DELETE',
      headers: as(sessionA),
    });
  assert.equal((await del()).status, 204);
  assert.equal((await del()).status, 204, 'already gone');
  assert.ok(!fs.existsSync(path.join(dir, 'files', 'indexeddb', 'v1', 'top', 'full')));
  assert.ok(fs.existsSync(path.join(dir, 'files', 'indexeddb', 'v1', 'top', 'name')));
});

test('foreign files, takeover, gzip', async () => {
  for (const stray of strays) {
    fs.mkdirSync(path.dirname(path.join(dir, 'files', stray)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', stray), 'foreign');
  }
  const b = await open('Safari on iPad', {
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json; charset=utf-8',
  });
  sessionB = b.header.session;
  assert.equal(b.headers['content-encoding'], 'gzip');
  assert.equal(b.rest, 0);
  assert.ok(Object.entries(files).every(([file, data]) => b.files[file]?.equals(data)));
  assert.equal(b.header.files.length, Object.keys(files).length);
  assert.equal(b.header.prefs.settings?.name, 'settings');
  assert.equal(b.header.prefs.bookmarks?.name, 'bookmarks');
  assert.equal(b.header.prefs.permissions?.name, 'permissions');
  assert.equal(b.header.id, first.header.id);
  assert.notEqual(sessionB, sessionA);
  const res = await put(sessionA, 'cookies.db', 'old');
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).reason, 'taken');
  const del = await request('/profile/files/cookies.db', {
    method: 'DELETE',
    headers: as(sessionA),
  });
  assert.equal(del.status, 409);
  assert.equal(
    (await put(sessionB, 'localstorage/https_new.ch_0.localstorage', 'new')).status,
    204,
  );
});

test('restart', async () => {
  assert.equal((await stopCli(server)).code, 0, 'SIGTERM ends cleanly');
  server = await startCli(env);
  const state = await info();
  assert.equal(state.id, first.header.id);
  assert.ok(state.files.some((file) => file.path === 'localstorage/https_new.ch_0.localstorage'));
  assert.ok(!state.files.some((file) => strays.includes(file.path)), 'foreign files not counted');
  assert.equal(
    state.bytes,
    state.files.reduce((sum, file) => sum + file.size, 0),
  );
  assert.equal(
    (await put(sessionB, 'localstorage/https_new.ch_0.localstorage', 'new2')).status,
    204,
  );
  const res = await put(sessionA, 'cookies.db', 'old');
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).reason, 'taken');
});

test('reset', async () => {
  const reset = (session, body) =>
    request('/profile/reset', { method: 'POST', headers: as(session), body: json(body) });
  for (const prefs of ['permissions', ['../x'], [1]])
    assert.equal((await reset(sessionB, { all: false, prefs })).status, 400, String(prefs));
  const res = await reset(sessionB, { all: false, prefs: ['permissions', 'missing'] });
  assert.equal(res.status, 204);
  const state = await info();
  assert.notEqual(state.id, first.header.id);
  assert.equal(state.files.length, 0);
  assert.equal(state.bytes, 0);
  const old = await put(sessionA, 'cookies.db', 'old');
  assert.equal(old.status, 409);
  assert.equal(JSON.parse(old.body).reason, 'reset');
  assert.equal((await put(sessionB, 'cookies.db', 'x')).status, 204, 'caller session stays');
  const c = await open('Chrome on Linux');
  assert.equal(c.header.prefs.settings?.name, 'settings');
  assert.equal(c.header.prefs.bookmarks?.name, 'bookmarks');
  assert.equal(c.header.prefs.permissions, undefined);
  assert.deepEqual(c.header.prefs.history, {});
  assert.equal(c.header.id, state.id);
  const taken = await put(sessionB, 'cookies.db', 'y');
  assert.equal(taken.status, 409);
  assert.equal(JSON.parse(taken.body).reason, 'taken');
  const stale = await request('/profile/reset', {
    method: 'POST',
    headers: as(sessionB),
    body: '{}',
  });
  assert.equal(stale.status, 409);
  const all = await request('/profile/reset', {
    method: 'POST',
    headers: as(c.header.session),
    body: json({ all: true }),
  });
  assert.equal(all.status, 204);
  const d = await open('Chrome on Linux');
  assert.equal(d.header.files.length, 0);
  assert.deepEqual(d.header.prefs, {});
  // Prefs have their own limits: 32 names, 4 MB together
  const prefsPut = (name, body) =>
    request(`/profile/prefs/${name}`, { method: 'PUT', headers: as(d.header.session), body });
  for (let i = 0; i < 32; i++) assert.equal((await prefsPut(`p${i}`, '1')).status, 204);
  assert.equal((await prefsPut('p32', '1')).status, 507, 'too many prefs');
  const big = json('x'.repeat(MB - 100));
  for (let i = 0; i < 4; i++) assert.equal((await prefsPut(`p${i}`, big)).status, 204);
  assert.equal((await prefsPut('p4', big)).status, 507, 'prefs too large together');
  assert.equal((await prefsPut('p0', '2')).status, 204, 'replacing frees its size');
  assert.equal((await reset(d.header.session, { all: true })).status, 204);
  assert.deepEqual((await open('Chrome on Linux')).header.prefs, {});
  const e = await open('Chrome on Linux');
  if (evilCookies) {
    assert.equal((await put(e.header.session, 'cookies.db', evilCookies)).status, 204);
    const start = Date.now();
    const evil = await request('/profile/info', { headers: auth });
    assert.equal(evil.status, 200);
    assert.equal(JSON.parse(evil.body).cookies, null);
    assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
  }
  await stopCli(server);
  server = null;
});

test('not writable, and without profile', async () => {
  fs.writeFileSync(path.join(temp, 'file'), '');
  const broken = await startCli({ PROFILE_DIR: path.join(temp, 'file', 'profile') });
  try {
    assert.ok(broken.ready);
    assert.equal((await httpRequest(broken.port, '/profile/info')).status, 503);
    assert.equal((await httpRequest(broken.port, '/healthz')).status, 200);
  } finally {
    await stopCli(broken);
  }
  const plain = await startCli();
  try {
    assert.equal((await httpRequest(plain.port, '/profile/info')).status, 404);
  } finally {
    await stopCli(plain);
  }
});

test('createProfileStore: authorize required, own path', async () => {
  const own = path.join(temp, 'own');
  assert.throws(() => createProfileStore({ dir: own }), TypeError);
  assert.throws(() => createProfileStore({ dir: own, authorize: true }), TypeError);
  assert.throws(
    () => createProfileStore({ dir: own, authorize: () => true, path: 'p/' }),
    TypeError,
  );
  const store = createProfileStore({ dir: own, path: '/user/profile/', authorize: () => true });
  const server = http.createServer(async (req, res) => {
    if (!(await store.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    assert.equal((await httpRequest(port, '/user/profile/info')).status, 200);
    assert.equal((await httpRequest(port, '/profile/info')).status, 404);
  } finally {
    server.close();
    await store.close();
  }
});
