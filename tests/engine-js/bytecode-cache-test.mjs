// Entry format of the bytecode cache (engine/js/bytecode-cache.js) without the engine: loaded in
// node with a fake Cache API and a fake engine (malloc into shared memory like the real one,
// bl__bytecode_cache_result records its arguments). Length and checksum are checked by the
// engine (engine/src/BytecodeCache.cpp), here only that they arrive.
//   node tests/engine-js/bytecode-cache-test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const isShared = (buffer) =>
  Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]';

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async match(url) {
    return this.entries.get(url)?.clone();
  }
  async put(url, response) {
    this.entries.delete(url);
    this.entries.set(url, response);
  }
}

function load() {
  const cache = new FakeCache();
  const opened = [];
  const deleted = [];
  const names = ['browserlite-bytecode-old', 'browserlite-http', 'other-bytecode-x'];
  const heap = new Uint8Array(new SharedArrayBuffer(1 << 16));
  let top = 8;
  const results = [];
  const mallocs = [];
  const strings = new Map();
  const context = {
    HEAPU8: heap,
    Module: {
      _malloc: (size) => {
        mallocs.push(size);
        const pointer = top;
        top += size;
        return pointer;
      },
      _free: () => {},
      _bl__bytecode_cache_result: (key, pointer, size, length, checksum) =>
        results.push({
          key: strings.get(key),
          pointer,
          size,
          length,
          checksum,
          bytes: heap.slice(pointer, pointer + size),
        }),
    },
    stringToNewUTF8: (text) => {
      const pointer = strings.size + 1;
      strings.set(pointer, text);
      return pointer;
    },
    caches: {
      keys: async () => names,
      open: async (name) => {
        opened.push(name);
        return cache;
      },
      delete: async (name) => {
        deleted.push(name);
        return true;
      },
    },
    // From engine-pre.js: the BL_STORAGE_NAMESPACE of the engine
    blStorageNamespace: () => 'browserlite',
    Response,
  };
  vm.createContext(context);
  vm.runInContext(
    readFileSync(new URL('../../engine/js/bytecode-cache.js', import.meta.url), 'utf8'),
    context,
  );
  const bytecode = vm.runInContext('blBytecodeCache', context);
  return { bytecode, cache, opened, deleted, heap, results, mallocs };
}

const payload = Uint8Array.from({ length: 100 }, (_, i) => (i * 7) & 255);
const checksum = 0x1234_5678_9abc_def0n;

// Header: magic "BLBC", version 1, length and checksum, little endian
{
  const { bytecode } = load();
  const entry = bytecode.entry(payload, checksum);
  const view = new DataView(entry.buffer);
  check('entry: header and bytecode', entry.length === 24 + payload.length);
  check('entry: magic BLBC', new TextDecoder().decode(entry.subarray(0, 4)) === 'BLBC');
  check('entry: version 1', view.getUint32(4, true) === 1);
  check('entry: length', view.getBigUint64(8, true) === 100n);
  check('entry: checksum', view.getBigUint64(16, true) === checksum);
  check(
    'entry: bytecode after the header',
    entry.subarray(24).every((byte, i) => byte === payload[i]),
  );
  const parsed = bytecode.parse(entry.buffer);
  check(
    'parse: fields of the header',
    parsed && parsed.length === 100n && parsed.checksum === checksum,
    JSON.stringify(parsed && { length: String(parsed.length), checksum: String(parsed.checksum) }),
  );
  check(
    'parse: bytecode without the header, no copy',
    parsed.bytecode.length === 100 &&
      parsed.bytecode.buffer === entry.buffer &&
      parsed.bytecode.byteOffset === 24,
  );
}

// Not an entry of this format: shorter than the header, other magic, other version
{
  const { bytecode } = load();
  const entry = bytecode.entry(payload, checksum);
  check('parse: shorter than the header', bytecode.parse(entry.slice(0, 23).buffer) === null);
  const magic = entry.slice();
  magic[0] = 0x58;
  check('parse: other magic', bytecode.parse(magic.buffer) === null);
  const version = entry.slice();
  version[4] = 2;
  check('parse: other version', bytecode.parse(version.buffer) === null);
  const truncated = bytecode.parse(entry.slice(0, 24 + 50).buffer);
  check(
    'parse: truncated entry keeps the length of the header (the engine rejects it)',
    truncated && truncated.length === 100n && truncated.bytecode.length === 50,
  );
}

// Store: one copy out of shared memory, the view may change right after the call
{
  const { bytecode, cache, opened, deleted, heap } = load();
  bytecode.open('build1');
  heap.set(payload, 4096);
  bytecode.store('https://site.test/app.js', heap.subarray(4096, 4096 + 100), checksum);
  heap.fill(0, 4096, 4096 + 100);
  await settle();
  check(
    'open: cache <namespace>-bytecode-<build id>',
    opened.join() === 'browserlite-bytecode-build1',
  );
  check(
    'open: only other builds of the namespace deleted',
    deleted.join() === 'browserlite-bytecode-old',
  );
  const url = bytecode.url('https://site.test/app.js');
  const response = cache.entries.get(url);
  check('store: entry under the key', !!response, [...cache.entries.keys()].join());
  const stored = new Uint8Array(await response.clone().arrayBuffer());
  const parsed = bytecode.parse(stored.buffer);
  check(
    'store: copied before the call returned',
    parsed.length === 100n &&
      parsed.checksum === checksum &&
      parsed.bytecode.every((byte, i) => byte === payload[i]),
  );
  check(
    'store: entry not in shared memory',
    !isShared(bytecode.entry(heap.subarray(4096, 4196), checksum).buffer),
  );
}

// Lookup: only the bytecode goes into engine memory, the header fields as arguments
{
  const { bytecode, cache, results, mallocs } = load();
  bytecode.open('build1');
  await settle();
  const key = 'https://site.test/app.js';
  await cache.put(bytecode.url(key), new Response(bytecode.entry(payload, checksum)));
  bytecode.urls.add(bytecode.url(key));
  bytecode.lookup(key);
  bytecode.lookup('https://site.test/missing.js');
  await settle();
  const hit = results.find((result) => result.key === key);
  check(
    'lookup: bytecode, its size, length and checksum',
    hit &&
      hit.pointer !== 0 &&
      hit.size === 100 &&
      hit.length === 100n &&
      hit.checksum === checksum &&
      hit.bytes.every((byte, i) => byte === payload[i]),
    JSON.stringify(hit && { pointer: hit.pointer, size: hit.size }),
  );
  check('lookup: malloc only for the bytecode', mallocs.join() === '100', mallocs.join());
  const miss = results.find((result) => result.key === 'https://site.test/missing.js');
  check(
    'lookup: no entry -> 0',
    miss && miss.pointer === 0 && miss.size === 0 && miss.length === 0n,
  );

  // An entry of another format is no entry (no copy into engine memory)
  const other = 'https://site.test/other.js';
  const broken = bytecode.entry(payload, checksum);
  broken[0] = 0;
  await cache.put(bytecode.url(other), new Response(broken));
  bytecode.urls.add(bytecode.url(other));
  bytecode.lookup(other);
  await settle();
  const result = results.find((entry) => entry.key === other);
  check(
    'lookup: other format -> 0',
    result && result.pointer === 0 && mallocs.length === 1,
    JSON.stringify(result && { pointer: result.pointer }),
  );
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('All checks ok');
