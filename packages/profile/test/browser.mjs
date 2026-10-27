// The profile client with the real origin private file system of the browser of tests/lib and the
// in-memory server of fake-server.mjs (playwright from the workspace):
//   npx tsc -b && node packages/profile/test/browser.mjs
// Not part of `npm test`, which runs without a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../tests/lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let browser;
let page;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><body></body>');
      return;
    }
    try {
      const file = path.join(root, path.normalize(url.pathname));
      if (!file.startsWith(root)) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launch();
  page = await browser.newPage();
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    window.lib = await import('/dist/index.js');
    window.FakeServer = (await import('/test/fake-server.mjs')).FakeServer;
    window.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.freshDir = async (name) => {
      const top = await navigator.storage.getDirectory();
      await top.removeEntry(name, { recursive: true }).catch(() => {});
      return top.getDirectoryHandle(name, { create: true });
    };
    window.writeFile = async (dir, path, text) => {
      const parts = path.split('/');
      let current = dir;
      for (const part of parts.slice(0, -1))
        current = await current.getDirectoryHandle(part, { create: true });
      const writable = await (
        await current.getFileHandle(parts.at(-1), { create: true })
      ).createWritable();
      await writable.write(text);
      await writable.close();
    };
    window.readFile = async (dir, path) => {
      try {
        const parts = path.split('/');
        let current = dir;
        for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part);
        return await (await (await current.getFileHandle(parts.at(-1))).getFile()).text();
      } catch {
        return null;
      }
    };
    window.listFiles = async (dir, prefix = '') => {
      const all = [];
      for await (const handle of dir.values()) {
        if (handle.kind === 'file') all.push(prefix + handle.name);
        else all.push(...(await listFiles(handle, `${prefix}${handle.name}/`)));
      }
      return all.sort();
    };
    window.fakeBrowser = (dir) => ({
      state: 'ready',
      flushes: 0,
      storage: {
        persistent: true,
        directory: dir,
        flush() {
          this.flushes++;
        },
        clearCaches: async () => {},
      },
    });
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('seed, sync, stats and reset with the real file system', { timeout: 60000 }, async () => {
  const result = await page.evaluate(async () => {
    localStorage.clear();
    const fake = new FakeServer();
    const enc = (text) => new TextEncoder().encode(text);
    fake.files.set('cookies.db', enc('server cookies'));
    fake.files.set(
      'indexeddb/v1/https_a.com_0/https_frame.com_0/db/IndexedDB.sqlite3',
      enc('frame db'),
    );
    fake.files.set('localstorage/https_a.com_0.localstorage', enc('ls'));
    fake.prefs.settings = { home: 'https://a.com' };
    const dir = await freshDir('browserlite');
    await writeFile(dir, 'stale/file', 'from no profile');
    const out = {};
    const profile = lib.createProfile({ url: '/profile/', fetch: fake.fetch });
    await profile.beforeStart(dir);
    out.status = profile.status;
    out.seeded = await listFiles(dir);
    out.frame = await readFile(
      dir,
      'indexeddb/v1/https_a.com_0/https_frame.com_0/db/IndexedDB.sqlite3',
    );
    out.settings = profile.prefs('settings');
    out.storageKeys = Object.keys(localStorage).sort();
    const browser = fakeBrowser(dir);
    profile.attach(browser);
    await writeFile(dir, 'cookies.db', 'engine cookies');
    await writeFile(dir, 'indexeddb/v1/https_b.com_0/db2/IndexedDB.sqlite3', 'new db');
    await writeFile(dir, 'indexeddb/v1/https_b.com_0/db2/IndexedDB.sqlite3-wal', 'wal');
    await writeFile(
      dir,
      'indexeddb/v1/https_big.com_0/huge/IndexedDB.sqlite3',
      'x'.repeat(300 * 1024),
    );
    await writeFile(dir, 'cachestorage/c', '123');
    profile.savePrefs('bookmarks', [{ url: 'https://b.com' }]);
    await sleep(2500);
    const text = (path) =>
      fake.files.has(path) ? new TextDecoder().decode(fake.files.get(path)) : null;
    out.uploaded = [
      text('cookies.db'),
      text('indexeddb/v1/https_b.com_0/db2/IndexedDB.sqlite3'),
      text('indexeddb/v1/https_b.com_0/db2/IndexedDB.sqlite3-wal'),
    ];
    out.bigUploaded = fake.files.has('indexeddb/v1/https_big.com_0/huge/IndexedDB.sqlite3');
    out.bookmarks = fake.prefs.bookmarks;
    const stats = await profile.localStats();
    out.stats = {
      databases: stats.databases,
      cacheStorage: stats.cacheStorage,
      httpCacheType: typeof stats.httpCache,
    };
    const info = await profile.info();
    out.infoFiles = info.files.length;
    await profile.reset(false);
    out.afterReset = [profile.status, profile.prefs('settings')?.home, fake.files.size];
    browser.state = 'destroyed';
    const next = lib.createProfile({ url: '/profile/', fetch: fake.fetch });
    await next.beforeStart(dir);
    out.restarted = [next.status, await listFiles(dir)];
    return out;
  });
  assert.equal(result.status, 'connected');
  assert.deepEqual(result.seeded, [
    'cookies.db',
    'indexeddb/v1/https_a.com_0/https_frame.com_0/db/IndexedDB.sqlite3',
    'localstorage/https_a.com_0.localstorage',
    'profile-id',
  ]);
  assert.equal(result.frame, 'frame db');
  assert.deepEqual(result.settings, { home: 'https://a.com' });
  assert.ok(
    result.storageKeys.every((key) => key.startsWith('bl-profile http://127.0.0.1')),
    result.storageKeys.join(),
  );
  assert.deepEqual(result.uploaded, ['engine cookies', 'new db', 'wal']);
  assert.equal(result.bigUploaded, false);
  assert.deepEqual(result.bookmarks, [{ url: 'https://b.com' }]);
  assert.deepEqual(result.stats.databases, [
    {
      path: 'indexeddb/v1/https_big.com_0/huge',
      site: 'https://big.com',
      size: 300 * 1024,
      kind: 'IndexedDB',
    },
  ]);
  assert.equal(result.stats.cacheStorage, 3);
  assert.equal(result.infoFiles, 5);
  assert.deepEqual(result.afterReset, ['off', 'https://a.com', 0]);
  assert.deepEqual(result.restarted, ['connected', ['profile-id']]);
});

test('server not reachable keeps the local files and reports local', async () => {
  const result = await page.evaluate(async () => {
    localStorage.clear();
    const fake = new FakeServer();
    fake.down = true;
    const dir = await freshDir('offline');
    await writeFile(dir, 'cookies.db', 'local');
    const profile = lib.createProfile({ url: '/profile/', fetch: fake.fetch });
    const events = [];
    profile.on('status', () => events.push(profile.status));
    await profile.beforeStart(dir);
    return {
      status: profile.status,
      text: profile.statusText,
      events,
      files: await listFiles(dir),
    };
  });
  assert.deepEqual(result, {
    status: 'local',
    text: 'Profile server not reachable, changes stay on this device',
    events: ['local'],
    files: ['cookies.db'],
  });
});
