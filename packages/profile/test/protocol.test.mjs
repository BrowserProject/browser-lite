import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, filePath, hostDevice, OpenReader } from '../dist/protocol.js';

function answer(head, contents) {
  const json = new TextEncoder().encode(JSON.stringify(head));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length, true);
  return concat([length, json, ...contents]);
}

test('OpenReader reads head and files from any chunking', () => {
  const head = {
    id: 'p',
    session: 'p.s',
    prefs: { settings: { a: 1 } },
    files: [
      { path: 'cookies.db', size: 3 },
      { path: 'localstorage/x.localstorage', size: 2 },
    ],
  };
  const bytes = answer(head, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  for (const size of [1, 2, 5, 7, bytes.length]) {
    const reader = new OpenReader();
    const heads = [];
    for (let i = 0; i < bytes.length; i += size) {
      const found = reader.push(bytes.slice(i, i + size));
      if (found) heads.push(found);
    }
    assert.equal(heads.length, 1, `head once with chunk size ${size}`);
    assert.deepEqual(heads[0], head);
    const { files } = reader.finish();
    assert.deepEqual(
      files.map((file) => [file.path, [...file.data]]),
      [
        ['cookies.db', [1, 2, 3]],
        ['localstorage/x.localstorage', [4, 5]],
      ],
    );
  }
});

test('OpenReader rejects incomplete and overlong answers', () => {
  const head = { id: 'p', session: 's', prefs: {}, files: [{ path: 'cookies.db', size: 3 }] };
  const short = new OpenReader();
  short.push(answer(head, [new Uint8Array([1, 2])]));
  assert.throws(() => short.finish(), /incomplete/);
  const long = new OpenReader();
  long.push(answer(head, [new Uint8Array([1, 2, 3, 4])]));
  assert.throws(() => long.finish(), /incomplete/);
  const none = new OpenReader();
  none.push(new Uint8Array([10, 0]));
  assert.throws(() => none.finish(), /incomplete/);
});

test('filePath encodes each segment', () => {
  assert.equal(
    filePath('indexeddb/v1/a b/c?d/IndexedDB.sqlite3'),
    'files/indexeddb/v1/a%20b/c%3Fd/IndexedDB.sqlite3',
  );
});

test('hostDevice names browser and system', () => {
  assert.equal(
    hostDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'),
    'Chrome on Linux',
  );
  assert.equal(
    hostDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36 Edg/140'),
    'Edge on Windows',
  );
  assert.equal(
    hostDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17 Safari/604.1'),
    'Safari on iOS',
  );
  assert.equal(
    hostDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Gecko/20100101 Firefox/130.0'),
    'Firefox on macOS',
  );
  assert.equal(hostDevice(''), 'Browser on unknown system');
});
