import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createProfile, statusTexts } from '../dist/index.js';
import { FakeDir } from './fake-fs.mjs';
import { FakeServer } from './fake-server.mjs';

// Memory localStorage shared by the client instances of one test (like one origin)
class MemoryStorage {
  #map = new Map();
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
}

const URL_BASE = 'http://profile.test/profile/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (bytes) => new TextDecoder().decode(bytes);

function fakeBrowser(dir) {
  const flushes = [];
  return {
    state: 'ready',
    flushes,
    storage: {
      persistent: true,
      directory: dir,
      flush: (ms) => flushes.push(ms ?? 0),
      clearCaches: async () => {},
    },
  };
}

let server;
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
  server = new FakeServer();
});

const open = (options = {}) => createProfile({ url: URL_BASE, fetch: server.fetch, ...options });

test('status starts off, prefs work locally without a start', () => {
  const profile = open();
  assert.equal(profile.status, 'off');
  assert.equal(profile.statusText, statusTexts.off);
  assert.equal(profile.prefs('settings'), undefined);
  profile.savePrefs('settings', { a: 1 });
  assert.deepEqual(profile.prefs('settings'), { a: 1 });
  assert.deepEqual(open().prefs('settings'), { a: 1 }, 'kept in localStorage');
  assert.equal(server.log.length, 0);
});

test('beforeStart puts the server profile into the directory', async () => {
  server.files.set('cookies.db', new TextEncoder().encode('cookies'));
  server.files.set(
    'indexeddb/v1/https_a.com_0/db/IndexedDB.sqlite3',
    new TextEncoder().encode('idb'),
  );
  server.prefs.bookmarks = [{ url: 'https://a.com' }];
  const dir = new FakeDir('browserlite');
  dir.put('stale.txt', 'from another profile');
  const profile = open();
  const events = [];
  profile.on('status', () => events.push(profile.status));
  await profile.beforeStart(dir);
  assert.equal(profile.status, 'connected');
  assert.deepEqual(events, ['connected']);
  assert.deepEqual(dir.paths(), [
    'cookies.db',
    'indexeddb/v1/https_a.com_0/db/IndexedDB.sqlite3',
    'profile-id',
  ]);
  assert.equal(dir.text('profile-id'), server.profile.id);
  assert.equal(dir.text('cookies.db'), 'cookies');
  assert.deepEqual(profile.prefs('bookmarks'), [{ url: 'https://a.com' }]);
  assert.equal(profile.prefs('settings'), undefined, 'null on the server reads as undefined');
  assert.match(server.device, / on /);
});

test('methods work unbound', async () => {
  const { beforeStart, savePrefs, prefs, prefsSaved } = open();
  await beforeStart(new FakeDir());
  savePrefs('settings', { u: 1 });
  await prefsSaved();
  assert.deepEqual(prefs('settings'), { u: 1 });
  assert.deepEqual(server.prefs.settings, { u: 1 });
});

test('the custom fetch carries authorization and the session header', async () => {
  const seen = [];
  const profile = createProfile({
    url: URL_BASE,
    fetch: (input, init) => {
      seen.push({ url: String(input), headers: { ...init.headers } });
      return server.fetch(input, {
        ...init,
        headers: { ...init.headers, Authorization: 'Bearer t' },
      });
    },
  });
  await profile.beforeStart(new FakeDir());
  profile.savePrefs('settings', { b: 2 });
  await profile.prefsSaved();
  assert.equal(seen[0].url, `${URL_BASE}open`);
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  assert.equal(seen[1].url, `${URL_BASE}prefs/settings`);
  assert.equal(seen[1].headers['X-Profile-Session'], server.profile.session);
  assert.equal(server.headers[1].authorization, 'Bearer t');
});

test('url without trailing slash and relative paths', async () => {
  const urls = [];
  const profile = createProfile({
    url: 'http://h.test/p',
    fetch: (input, init) => {
      urls.push(String(input));
      return server.fetch(input, init);
    },
  });
  await profile.beforeStart(new FakeDir());
  assert.equal(urls[0], 'http://h.test/p/open');
});

test('savePrefs goes to the server; prefsSaved waits', async () => {
  const profile = open();
  await profile.beforeStart(new FakeDir());
  profile.savePrefs('settings', { theme: 'dark' });
  profile.savePrefs('permissions', { 'geolocation https://a.com': 1 });
  await profile.prefsSaved();
  assert.deepEqual(server.prefs.settings, { theme: 'dark' });
  assert.deepEqual(server.prefs.permissions, { 'geolocation https://a.com': 1 });
});

test('server unreachable: local, prefs are sent at the next start and win', async () => {
  server.prefs.settings = { theme: 'light' };
  server.down = true;
  const dir = new FakeDir();
  const first = open();
  await first.beforeStart(dir);
  assert.equal(first.status, 'local');
  assert.equal(first.statusText, statusTexts.local);
  first.savePrefs('settings', { theme: 'dark' });
  assert.equal(await first.info(), null);
  server.down = false;
  const second = open();
  await second.beforeStart(dir);
  assert.equal(second.status, 'connected');
  assert.deepEqual(second.prefs('settings'), { theme: 'dark' }, 'unsent local value wins');
  await second.prefsSaved();
  assert.deepEqual(server.prefs.settings, { theme: 'dark' });
});

test('another device takes over: taken, nothing more is written', async () => {
  const profile = open();
  await profile.beforeStart(new FakeDir());
  const events = [];
  profile.on('status', () => events.push(profile.status));
  server.takeOver();
  profile.savePrefs('settings', { x: 1 });
  await profile.prefsSaved();
  assert.equal(profile.status, 'taken');
  assert.equal(profile.statusText, statusTexts.taken);
  assert.deepEqual(events, ['taken']);
  assert.equal(server.prefs.settings, undefined);
  await assert.rejects(profile.reset(false), new RegExp(statusTexts.taken));
});

test('attach syncs changes and deletes after the second miss', { timeout: 20000 }, async () => {
  const dir = new FakeDir();
  const profile = open();
  await profile.beforeStart(dir);
  const browser = fakeBrowser(dir);
  profile.attach(browser);
  dir.put('cookies.db', 'c1');
  dir.put('localstorage/https_a.com_0.localstorage', 'ls');
  dir.put('localstorage/https_big.com_0.localstorage', 'x'.repeat(300 * 1024));
  await sleep(2400);
  assert.equal(text(server.files.get('cookies.db')), 'c1');
  assert.equal(text(server.files.get('localstorage/https_a.com_0.localstorage')), 'ls');
  assert.ok(
    !server.files.has('localstorage/https_big.com_0.localstorage'),
    'above 256 KB stays local',
  );
  const stats = await profile.localStats();
  assert.deepEqual(
    stats.databases.map((db) => [db.path, db.site, db.kind]),
    [['localstorage/https_big.com_0.localstorage', 'https://big.com', 'localStorage']],
  );
  const puts = server.log.filter((entry) => entry.startsWith('PUT files/')).length;
  await sleep(2100);
  assert.equal(
    server.log.filter((entry) => entry.startsWith('PUT files/')).length,
    puts,
    'unchanged files are not uploaded again',
  );
  await dir
    .getDirectoryHandle('localstorage')
    .then((d) => d.removeEntry('https_a.com_0.localstorage'));
  await sleep(2100);
  assert.ok(
    server.files.has('localstorage/https_a.com_0.localstorage'),
    'kept after the first miss',
  );
  await sleep(2100);
  assert.ok(
    !server.files.has('localstorage/https_a.com_0.localstorage'),
    'deleted after the second miss',
  );
  browser.state = 'destroyed';
  await sleep(2100);
  const count = server.log.length;
  await sleep(2100);
  assert.equal(server.log.length, count, 'no sync after destroy');
});

test('a file the server rejects sets a problem until it changes', { timeout: 10000 }, async () => {
  server.maxFileBytes = 10;
  const dir = new FakeDir();
  const profile = open();
  await profile.beforeStart(dir);
  const problems = [];
  profile.on('status', () => problems.push(profile.problem));
  const browser = fakeBrowser(dir);
  profile.attach(browser);
  dir.put('cookies.db', 'x'.repeat(20));
  await sleep(2300);
  assert.match(profile.problem, /fits/);
  assert.deepEqual(problems, [profile.problem]);
  const puts = server.log.filter((entry) => entry === 'PUT files/cookies.db').length;
  await sleep(2100);
  assert.equal(
    server.log.filter((entry) => entry === 'PUT files/cookies.db').length,
    puts,
    'not retried unchanged',
  );
  browser.state = 'destroyed';
});

test('dbLimitKB as a function is read at every sync', { timeout: 10000 }, async () => {
  let limit = 1;
  const dir = new FakeDir();
  const profile = open({ dbLimitKB: () => limit });
  await profile.beforeStart(dir);
  const browser = fakeBrowser(dir);
  profile.attach(browser);
  dir.put('localstorage/https_a.com_0.localstorage', 'x'.repeat(2048));
  await sleep(2300);
  assert.ok(!server.files.has('localstorage/https_a.com_0.localstorage'));
  limit = 4;
  await sleep(2100);
  assert.ok(server.files.has('localstorage/https_a.com_0.localstorage'));
  browser.state = 'destroyed';
});

test('restart catches up on changes that were not uploaded and keeps them', async () => {
  const dir = new FakeDir();
  const first = open();
  await first.beforeStart(dir);
  // The engine wrote while no sync ran (tab closed right after)
  dir.put('cookies.db', 'local change');
  server.files.set('localstorage/https_s.com_0.localstorage', new TextEncoder().encode('server'));
  const second = open();
  await second.beforeStart(dir);
  assert.equal(second.status, 'connected');
  assert.equal(text(server.files.get('cookies.db')), 'local change');
  assert.equal(dir.text('cookies.db'), 'local change');
  assert.equal(dir.text('localstorage/https_s.com_0.localstorage'), 'server');
});

test('a restart in the same page waits for the running sync, then catches up', {
  timeout: 10000,
}, async () => {
  server.files.set('cookies.db', new TextEncoder().encode('v1'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = 0;
  const fetch = async (input, init) => {
    if (init?.method === 'PUT') {
      held++;
      await gate;
    }
    return server.fetch(input, init);
  };
  const dir = new FakeDir();
  const profile = open({ fetch });
  await profile.beforeStart(dir);
  const browser = fakeBrowser(dir);
  profile.attach(browser);
  dir.put('cookies.db', 'v2');
  while (!held) await sleep(50);
  // The engine writes once more while it shuts down; the running sync scanned before
  dir.put('cookies.db', 'v3');
  browser.state = 'destroyed';
  const restart = profile.beforeStart(dir);
  await sleep(100);
  release();
  await restart;
  assert.equal(dir.text('cookies.db'), 'v3', 'the newest local change survives the seed');
  assert.equal(text(server.files.get('cookies.db')), 'v3');
});

test('a database deleted on another device is deleted here', async () => {
  server.files.set('cookies.db', new TextEncoder().encode('c'));
  server.files.set('localstorage/https_a.com_0.localstorage', new TextEncoder().encode('a'));
  const dir = new FakeDir();
  await open().beforeStart(dir);
  assert.equal(dir.text('localstorage/https_a.com_0.localstorage'), 'a');
  dir.put('localstorage/https_local.com_0.localstorage', 'never in the profile');
  server.files.delete('localstorage/https_a.com_0.localstorage');
  await open().beforeStart(dir);
  assert.equal(dir.text('localstorage/https_a.com_0.localstorage'), undefined);
  assert.equal(
    dir.text('localstorage/https_local.com_0.localstorage'),
    'never in the profile',
    'uploaded at catch up, then from the server',
  );
  assert.ok(server.files.has('localstorage/https_local.com_0.localstorage'));
});

test('reset(false) clears site data and permissions, the next start clears the directory', async () => {
  server.prefs.settings = { s: 1 };
  server.prefs.permissions = { p: 1 };
  server.files.set('cookies.db', new TextEncoder().encode('c'));
  const dir = new FakeDir();
  const profile = open();
  await profile.beforeStart(dir);
  dir.put('cachestorage/x', 'cache');
  await profile.reset(false);
  assert.equal(profile.status, 'off');
  assert.equal(profile.prefs('permissions'), undefined);
  assert.deepEqual(profile.prefs('settings'), { s: 1 });
  assert.equal(server.files.size, 0);
  assert.equal(server.prefs.permissions, undefined);
  assert.deepEqual(server.prefs.settings, { s: 1 });
  const next = open();
  await next.beforeStart(dir);
  assert.equal(next.status, 'connected');
  assert.deepEqual(dir.paths(), ['profile-id']);
  assert.deepEqual(next.prefs('settings'), { s: 1 });
});

test('reset(false) clears the sitePrefs of the options', async () => {
  server.prefs.settings = { s: 1 };
  server.prefs.permissions = { p: 1 };
  server.prefs.grants = { g: 1 };
  const profile = open({ sitePrefs: ['grants'] });
  await profile.beforeStart(new FakeDir());
  await profile.reset(false);
  assert.equal(profile.prefs('grants'), undefined);
  assert.deepEqual(profile.prefs('permissions'), { p: 1 });
  assert.deepEqual(Object.keys(server.prefs).sort(), ['permissions', 'settings']);
});

test('a pref the server refuses stays local and never blocks the others', async () => {
  const profile = open();
  await profile.beforeStart(new FakeDir());
  profile.savePrefs('Bad.Name', 1);
  profile.savePrefs('good', 2);
  await profile.prefsSaved();
  assert.deepEqual(server.prefs, { good: 2 });
  assert.equal(profile.prefs('Bad.Name'), 1);
  assert.match(profile.problem, /Bad\.Name.*400/);
  profile.savePrefs('later', 3);
  await profile.prefsSaved();
  assert.equal(server.prefs.later, 3);
  assert.equal(server.log.filter((entry) => String(entry).includes('Bad.Name')).length, 1);
});

test('reset(true) clears all prefs; reset while local only clears here', async () => {
  server.prefs.settings = { s: 1 };
  server.prefs.bookmarks = [1];
  const profile = open();
  await profile.beforeStart(new FakeDir());
  await profile.reset(true);
  assert.equal(profile.prefs('settings'), undefined);
  assert.equal(profile.prefs('bookmarks'), undefined);
  assert.equal(server.prefs.settings, undefined);

  server.down = true;
  const local = open();
  await local.beforeStart(new FakeDir());
  local.savePrefs('bookmarks', [2]);
  const before = server.log.length;
  await local.reset(true);
  assert.equal(server.log.length, before);
  assert.equal(local.prefs('bookmarks'), undefined);
});

test('reset is refused when off', async () => {
  await assert.rejects(open().reset(true), new RegExp(statusTexts.off));
});

test('info returns the server answer while connected', async () => {
  const profile = open();
  assert.equal(await profile.info(), null);
  await profile.beforeStart(new FakeDir());
  const info = await profile.info();
  assert.equal(info.id, server.profile.id);
  assert.deepEqual(info.cookies, []);
});

test('localStats sums the local only directories', async () => {
  const dir = new FakeDir();
  const profile = open();
  await profile.beforeStart(dir);
  dir.put('cachestorage/a/b', '12345');
  dir.put('serviceworkers/x', '12');
  dir.put('opfs/f', '1');
  const stats = await profile.localStats();
  assert.equal(stats.cacheStorage, 5);
  assert.equal(stats.serviceWorkers, 2);
  assert.equal(stats.pageFiles, 1);
  assert.deepEqual(stats.databases, []);
});

test('hiding the page syncs soon, the core flushes the storage', { timeout: 10000 }, async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  let listeners = 0;
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (...args) => {
    listeners++;
    add(...args);
  };
  globalThis.document = doc;
  try {
    const dir = new FakeDir();
    const profile = open();
    await profile.beforeStart(dir);
    const browser = fakeBrowser(dir);
    profile.attach(browser);
    profile.attach(browser);
    dir.put('cookies.db', 'before hide');
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(listeners, 1, 'attach twice adds no second listener');
    assert.deepEqual(browser.flushes, [], 'flushing on hide is the job of the core');
    await sleep(2200);
    assert.ok(!server.files.has('cookies.db'), 'hidden: sync waits 2.5 s after hide');
    await sleep(600);
    assert.equal(text(server.files.get('cookies.db')), 'before hide');
    browser.state = 'destroyed';
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    await sleep(2200);
  } finally {
    delete globalThis.document;
  }
});
