// HTTP cache (engine/js/http-cache.js) without the engine: loaded in node, the Cache API is a
// fake with the same order as in the browser (storing appends at the end, replacing too). Key
// format with the partition, cache names by format version (other formats deleted), cleanup.
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

function load(namespace = 'browserlite', names = []) {
  const cache = new FakeCache();
  const opened = [];
  const deleted = [];
  const replies = [];
  const heap = new Uint8Array(1 << 16);
  let top = 8;
  const context = {
    HEAPU8: heap,
    Module: {
      _malloc: (size) => {
        const pointer = top;
        top += size;
        return pointer;
      },
      _free: () => {},
      _bl__http_cache_result: (id, status, headers, headersLength, body, bodyLength) =>
        replies.push({
          id,
          status,
          body: new TextDecoder().decode(heap.slice(body, body + bodyLength)),
        }),
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
    blStorageNamespace: () => namespace,
    navigator: {},
    Headers,
    Response,
    TextEncoder,
    URLSearchParams,
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
  return { http, cache, opened, deleted, replies, module: context.Module };
}

const entry = (size) => new Response(null, { headers: { 'x-bl-size': String(size) } });

async function fill(http, cache, count, size) {
  await http.open();
  for (let i = 0; i < count; i++) await cache.put(`https://example.test/${i}`, entry(size));
}

// The cache is named after the storage namespace and the format version. Opening deletes the
// other formats of the namespace (no migration), clearing deletes all of them, both only touch
// the own namespace
{
  const names = [
    'shop_1-http',
    'shop_1-http-v1',
    'shop_1-http-v2',
    'shop_12-http',
    'other-http-v2',
    'shop_1-httpx',
  ];
  const { http, opened, deleted, module } = load('shop_1', names);
  await http.open();
  check('cache name <namespace>-http-v2', opened.join() === 'shop_1-http-v2', opened.join());
  check(
    'opening deletes the other formats of the namespace',
    deleted.join() === 'shop_1-http,shop_1-http-v1',
    deleted.join(),
  );
  deleted.length = 0;
  await module.blClearHttpCache();
  check(
    'clearing deletes all formats of the own namespace',
    deleted.join() === 'shop_1-http,shop_1-http-v1,shop_1-http-v2',
    deleted.join(),
  );
}

// Key: https://http.invalid/?p=<partition>&u=<url>, form encoded, already in the form the Cache
// API gives back (also for characters the URL parser would encode, like ')
{
  const { http } = load();
  const partition = 's_https://a.test https://b.test';
  const url = "https://c.test/x?y=1&z=it's#no";
  const key = http.key(partition, url);
  const parsed = new URL(key);
  check(
    'key: host and fields',
    parsed.origin === 'https://http.invalid' &&
      parsed.searchParams.get('p') === partition &&
      parsed.searchParams.get('u') === url &&
      [...parsed.searchParams.keys()].join() === 'p,u',
    key,
  );
  check('key: as the Cache API gives it back', parsed.href === key, parsed.href);
}

// Lookup only finds an entry in its own partition
{
  const { http, replies } = load();
  await http.open();
  const url = 'https://cdn.test/lib.js';
  http.store(
    'http://a.test http://a.test',
    url,
    200,
    'Content-Type: text/javascript\n',
    new TextEncoder().encode('lib'),
  );
  for (let i = 0; i < 20 && !http.urls.size; i++) await tick();
  http.lookup(1, 'http://a.test http://a.test', url);
  http.lookup(2, 'http://b.test http://b.test', url);
  http.lookup(3, 'http://b.test http://a.test', url);
  for (let i = 0; i < 20 && replies.length < 3; i++) await tick();
  const status = (id) => replies.find((reply) => reply.id === id)?.status;
  check(
    'lookup: hit in the same partition',
    status(1) === 200 && replies.find((reply) => reply.id === 1).body === 'lib',
    JSON.stringify(replies),
  );
  check('lookup: miss from another top site', status(2) === 0, String(status(2)));
  check('lookup: miss in a frame of another top site', status(3) === 0, String(status(3)));
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
  for (let i = 6; i < 9; i++)
    http.store(
      'https://a.test https://a.test',
      `https://example.test/${i}`,
      200,
      '',
      new Uint8Array(100),
    );
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
