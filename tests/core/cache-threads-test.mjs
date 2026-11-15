// The Cache API from several threads at once (engine/src/CacheStorageWasm.cpp). WebCore calls a
// worker's CacheStorageConnection on the worker's own thread; the engine's connection keeps all
// caches of all origins in one place, which only the engine thread may touch. Before, workers
// changed it from their threads while the engine thread read or wrote it (a put grew the list of
// entries that the 500 ms write of the origin's file was encoding): the engine aborted after
// minutes of tabs with a busy service worker (nytimes.com caches about 1000 responses), out of
// memory in WTF::Persistence::Encoder while it encoded freed memory as strings, or entries got
// lost. Here dedicated workers and the page put, list and delete entries of the same cache at the
// same time; afterwards every entry must be there with its body and the engine must answer.
//
//   node tests/core/cache-threads-test.mjs [engine-dir]
//   CACHE_WORKERS (default 4), CACHE_ENTRIES per thread (default 300)
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(300000);

const WORKERS = Number(process.env.CACHE_WORKERS ?? 4);
const ENTRIES = Number(process.env.CACHE_ENTRIES ?? 300);

// One writer: puts ENTRIES entries under /<name>/<i> (with a header), lists the cache every 10
// and deletes every third entry again once it is in, so the entries move under the readers
const WRITER = `async function writeEntries(name) {
  const cache = await caches.open('race');
  for (let i = 0; i < ${ENTRIES}; i++) {
    await cache.put('/' + name + '/' + i, new Response(name + ':' + i + ':' + 'x'.repeat(200), { headers: { 'X-Entry': name + '-' + i } }));
    if (i % 10 === 0) await cache.keys();
    if (i % 3 === 2) await cache.delete('/' + name + '/' + (i - 2));
  }
  return 'ok';
}`;
const WORKER = `${WRITER}
onmessage = (e) => writeEntries(e.data).then((r) => postMessage(r), (err) => postMessage(String(err)));`;
const PAGE = `<!doctype html><title>Cache threads</title><body>Cache threads<script>
${WRITER}
const log = (text) => console.log('RESULT ' + text);
(async () => {
  await caches.delete('race');
  const workers = Array.from({ length: ${WORKERS} }, (_, i) => new Promise((resolve) => {
    const worker = new Worker('/worker.js');
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage('w' + i);
  }));
  let done = false;
  let reads = 0;
  const reader = (async () => {
    const cache = await caches.open('race');
    while (!done) {
      await cache.matchAll();
      reads++;
    }
  })();
  const outcomes = await Promise.all([writeEntries('page'), ...workers]);
  done = true;
  await reader;
  log('writers=' + outcomes.map((o) => o.replace(/\\s+/g, '_')).join(','));
  log('reads=' + reads);
  const cache = await caches.open('race');
  const keys = (await cache.keys()).map((r) => new URL(r.url).pathname);
  const expected = [];
  for (const name of ['page', ...Array.from({ length: ${WORKERS} }, (_, i) => 'w' + i)])
    for (let i = 0; i < ${ENTRIES}; i++)
      if (i % 3 !== 0 || i + 2 >= ${ENTRIES}) expected.push('/' + name + '/' + i);
  const have = new Set(keys);
  const missing = expected.filter((k) => !have.has(k));
  const extra = keys.length - (expected.length - missing.length);
  log('entries=' + keys.length + '/' + expected.length + ',missing=' + missing.length + ',extra=' + extra + (missing.length ? ',first=' + missing[0] : ''));
  let wrong = 0;
  for (const key of expected.filter((_, i) => i % 7 === 0)) {
    const response = await cache.match(key);
    const [name, i] = key.slice(1).split('/');
    const ok = response && response.headers.get('X-Entry') === name + '-' + i && (await response.text()).startsWith(name + ':' + i + ':');
    if (!ok) wrong++;
  }
  log('wrong=' + wrong);
})().catch((e) => log('error=' + String(e).replace(/\\s+/g, '_')));
</script>`;

const { url } = await serve((req, res) => {
  if (req.url === '/worker.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(WORKER);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const tab = await browser.newPage();
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url })));

const crashLine = () => results.logs.find((line) => line.includes('engine crashed'));
const writers = await results.wait('writers', 120000, () => results.has('error') || !!crashLine());
const state = await tab.evaluate(() => window.blTest.browser?.state ?? 'none').catch(() => 'gone');
const engineCrashed = !!crashLine() || state === 'crashed' || state === 'gone';
check('engine does not crash', !engineCrashed, (crashLine() ?? state).slice(0, 300));
check(
  'every writer finishes',
  writers === `${'ok,'.repeat(WORKERS)}ok`,
  `${writers} ${results.get('error') ?? ''}`,
);
if (writers !== null) {
  const entries = await results.wait('entries', 60000);
  check(
    'every entry is there exactly once',
    /^(\d+)\/\1,missing=0,extra=0$/.test(entries ?? ''),
    entries,
  );
  check('entries keep their headers and bodies', (await results.wait('wrong', 60000)) === '0');
  console.log(`    reads while writing: ${results.get('reads')}`);
}
if (!engineCrashed) {
  await evalPage(tab, `console.log('RESULT alive=' + 6 * 7)`);
  check('engine answers afterwards', (await results.wait('alive', 20000)) === '42');
}

await browser.close();
finish();
