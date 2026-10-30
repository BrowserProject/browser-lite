import assert from 'node:assert/strict';
import { test } from 'node:test';
import { siteOfPath } from '../dist/index.js';
import { scan, unitOf, validName } from '../dist/scan.js';
import { FakeDir } from './fake-fs.mjs';

test('unitOf groups IndexedDB files by directory', () => {
  assert.equal(unitOf('cookies.db'), 'cookies.db');
  assert.equal(
    unitOf('localstorage/https_a.com_0.localstorage'),
    'localstorage/https_a.com_0.localstorage',
  );
  assert.equal(unitOf('indexeddb/v1/o/db/IndexedDB.sqlite3'), 'indexeddb/v1/o/db');
  assert.equal(unitOf('indexeddb/v1/o/f/db/IndexedDB.sqlite3-wal'), 'indexeddb/v1/o/f/db');
});

test('validName rejects names the server refuses', () => {
  assert.ok(validName('IndexedDB.sqlite3'));
  for (const name of ['', '.hidden', 'a\\b', 'x-corrupted', 'ä'.repeat(128)])
    assert.ok(!validName(name), name);
  assert.ok(validName('ä'.repeat(127)));
});

test('siteOfPath reads the WebKit origin names', () => {
  assert.equal(siteOfPath('localstorage/https_example.com_0.localstorage'), 'https://example.com');
  assert.equal(
    siteOfPath('localstorage/http_localhost_8080.localstorage'),
    'http://localhost:8080',
  );
  assert.equal(siteOfPath('indexeddb/v1/https_a.org_0/db'), 'https://a.org');
  assert.equal(siteOfPath('indexeddb/v1/weird/db'), 'weird');
});

test('scan finds cookies, localStorage and IndexedDBs with limits', async () => {
  const top = new FakeDir();
  top.put('cookies.db', 'c'.repeat(5000));
  top.put('localstorage/https_a.com_0.localstorage', 'small');
  top.put('localstorage/https_b.com_0.localstorage', 'x'.repeat(2000));
  top.put('localstorage/LegacyStorageTracker.db', 'ignored');
  top.put('localstorage/.hidden.localstorage', 'ignored');
  top.put('indexeddb/v1/https_a.com_0/db1/IndexedDB.sqlite3', 'abc');
  top.put('indexeddb/v1/https_a.com_0/db1/IndexedDB.sqlite3-wal', 'de');
  top.put('indexeddb/v1/https_a.com_0/db1/x-corrupted', 'skip');
  top.put('indexeddb/v1/https_a.com_0/db1/.IndexedDB.sqlite3-bllog', 'log');
  top.put('indexeddb/v1/https_a.com_0/deleted/.IndexedDB.sqlite3-bllog', 'log');
  top.put('.cookies.db-bllog', 'log');
  top.put('indexeddb/v1/https_a.com_0/https_frame.com_0/db2/IndexedDB.sqlite3', '1');
  top.put('indexeddb/v1/https_a.com_0/replacing/journal', 'tmp');
  await top
    .getDirectoryHandle('indexeddb')
    .then((d) => d.getDirectoryHandle('v1'))
    .then((d) => d.getDirectoryHandle('https_a.com_0'))
    .then((d) => d.getDirectoryHandle('empty', { create: true }));
  const units = await scan(top, 1000);
  const byKey = Object.fromEntries(units.map((unit) => [unit.key, unit]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    'cookies.db',
    'indexeddb/v1/https_a.com_0/db1',
    'indexeddb/v1/https_a.com_0/https_frame.com_0/db2',
    'indexeddb/v1/https_a.com_0/replacing',
    'localstorage/https_a.com_0.localstorage',
    'localstorage/https_b.com_0.localstorage',
  ]);
  assert.equal(byKey['cookies.db'].big, false, 'cookies.db has no limit');
  assert.equal(byKey['localstorage/https_b.com_0.localstorage'].big, true);
  assert.equal(byKey['localstorage/https_a.com_0.localstorage'].big, false);
  const db1 = byKey['indexeddb/v1/https_a.com_0/db1'];
  assert.equal(db1.size, 5);
  assert.deepEqual(db1.files.map((file) => file.path).sort(), [
    'indexeddb/v1/https_a.com_0/db1/IndexedDB.sqlite3',
    'indexeddb/v1/https_a.com_0/db1/IndexedDB.sqlite3-wal',
  ]);
  assert.equal(byKey['indexeddb/v1/https_a.com_0/replacing'].unstable, true);
});

test('scan stops reading a database above the limit and marks files being replaced', async () => {
  const top = new FakeDir();
  top.put('indexeddb/v1/o/db/IndexedDB.sqlite3', 'x'.repeat(600));
  top.put('indexeddb/v1/o/db/IndexedDB.sqlite3-wal', 'y'.repeat(600));
  top.put('indexeddb/v1/o/db/IndexedDB.sqlite3-shm', 'z'.repeat(600));
  const busy = top.put('localstorage/https_c.com_0.localstorage', 'busy');
  busy.failNext = 'NotFoundError';
  const units = await scan(top, 1000);
  const db = units.find((unit) => unit.key === 'indexeddb/v1/o/db');
  assert.equal(db.big, true);
  assert.equal(db.files.length, 2);
  const ls = units.find((unit) => unit.key === 'localstorage/https_c.com_0.localstorage');
  assert.equal(ls.unstable, true);
  assert.equal(ls.files.length, 0);
});

test('scan of an empty directory', async () => {
  assert.deepEqual(await scan(new FakeDir(), 1000), []);
});
