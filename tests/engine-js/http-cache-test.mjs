// Cleanup of the HTTP cache (engine/js/http-cache.js) without the engine:
// loaded in node, the Cache API is a fake with the same order as in the browser
// (storing appends at the end, replacing too).
//   node tests/engine-js/http-cache-test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeCache {
  constructor() {
    this.entries = new Map();
    this.onMatch = null;
    this.fail = false;
  }
  async keys() {
    if (this.fail) throw new Error('broken');
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    if (this.onMatch) await this.onMatch(url);
    return this.entries.get(url);
  }
  async put(url, response) {
    this.entries.delete(url);
    this.entries.set(url, response);
  }
  async delete(request) {
    return this.entries.delete(request.url);
  }
}

function load(namespace = 'browserlite') {
  const cache = new FakeCache();
  const opened = [];
  const deleted = [];
  const context = {
    Module: {},
    caches: {
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
    blStorageNamespace: () => namespace,
    navigator: {},
    Headers,
    Response,
    TextEncoder,
    Promise,
    Number,
    String,
    Set,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(
    readFileSync(new URL('../../engine/js/http-cache.js', import.meta.url), 'utf8'),
    context,
  );
  const http = vm.runInContext('blHttpCache', context);
  return { http, cache, opened, deleted, module: context.Module };
}

const entry = (size) => new Response(null, { headers: { 'x-bl-size': String(size) } });

async function fill(http, cache, count, size) {
  await http.open();
  for (let i = 0; i < count; i++) await cache.put(`https://example.test/${i}`, entry(size));
}

// The cache is named after the storage namespace, clearing only touches that one
{
  const { http, opened, deleted, module } = load('shop_1');
  await http.open();
  await module.blClearHttpCache();
  check('cache name <namespace>-http', opened.join(',') === 'shop_1-http', opened.join(','));
  check(
    'clearing deletes only the own cache',
    deleted.join(',') === 'shop_1-http',
    deleted.join(','),
  );
}

// Above the limit: the oldest go away until 80 % are used
{
  const { http, cache } = load();
  await fill(http, cache, 10, 100);
  http.limit = 900;
  await http.trim(false);
  const left = [...cache.entries.keys()].map((url) => url.split('/').pop());
  check('oldest entries deleted', left.join(',') === '3,4,5,6,7,8,9', left.join(','));
  check('usage counted afterwards', http.total === 700, String(http.total));
}

// Quota full (force): down to 80 % of the usage even below the limit
{
  const { http, cache } = load();
  await fill(http, cache, 10, 100);
  http.limit = 5000;
  await http.trim(true);
  check(
    'quota full: cleaned to 80 %',
    cache.entries.size === 8 && http.total === 800,
    `${cache.entries.size} entries, ${http.total}`,
  );
  await http.trim(false);
  check('below the limit: nothing deleted', cache.entries.size === 8, String(cache.entries.size));
}

// A put while counting replaces an entry (moves to the end): the sizes still
// belong to the right keys
{
  const { http, cache } = load();
  await http.open();
  await cache.put('https://example.test/big', entry(1000));
  for (let i = 0; i < 4; i++) await cache.put(`https://example.test/${i}`, entry(10));
  http.limit = 900;
  let replaced = false;
  cache.onMatch = async () => {
    if (!replaced) {
      replaced = true;
      await cache.put('https://example.test/0', entry(10));
    }
    await tick();
  };
  await http.trim(false);
  const left = [...cache.entries.keys()].map((url) => url.split('/').pop());
  check(
    'big old entry deleted, small ones stay',
    !left.includes('big') && left.length === 4,
    left.join(','),
  );
}

// Stores while a cleanup counts: a cleanup follows, the cache ends below the limit and the
// usage matches its content
{
  const { http, cache } = load();
  await fill(http, cache, 6, 100);
  http.total = 600;
  http.limit = 500;
  cache.onMatch = tick;
  const running = http.trim(false);
  for (let i = 6; i < 9; i++) http.store(`https://example.test/${i}`, 200, '', new Uint8Array(100));
  await running;
  for (let i = 0; i < 50 && http.trimming === null; i++) await tick();
  while (http.trimming) await http.trimming;
  let real = 0;
  for (const response of cache.entries.values()) real += Number(response.headers.get('x-bl-size'));
  check('stores during a cleanup: below the limit', real <= 500, `${real} bytes`);
  check(
    'stores during a cleanup: usage counted right',
    http.total === real,
    `${http.total} / ${real}`,
  );
}

// Counting fails: do not count everything again on every store
{
  const { http, cache } = load();
  await http.open();
  cache.fail = true;
  await http.trim(false);
  check('known usage after an error', http.total === 0, String(http.total));
  check('no cleanup pending after an error', http.trimming === null);
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('All checks ok');
