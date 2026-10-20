// HTTP cache of the engine (engine/src/HttpCache.cpp): after a reload of the whole host page (new
// engine, empty memory cache) fresh answers must come from the cache, answers with an ETag are
// revalidated (304), no-store always comes from the network. Also the bytecode cache
// (engine/src/BytecodeCache.cpp): a large script comes as finished bytecode on the second visit,
// a changed script under the same URL must not take the old bytecode, a script behind a redirect
// or answered by a service worker with another URL hits under the URL the page asked for, a
// truncated entry or one with a wrong checksum is rejected (the script still runs), other JSC
// options use another cache and an empty BL_BUILD_ID turns it off. Also: headers with an
// umlaut are the same from the cache as from the network, an answer that only ends with the
// connection is not stored, and over the limit (with a small quota here) the oldest entries go
// away. Persistent storage (the caches need it).
//
//   node tests/core/cache-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(2 * TIMEOUT + 300000);

const PAGE = `<!doctype html><title>Cache test</title><link rel=stylesheet href="/etag.css"><script src="/fresh.js"></script>
<body>Cache<script>
(async () => {
  const text = await (await fetch('/nostore.txt')).text();
  console.log('RESULT umlaut=' + (await fetch('/umlaut.txt')).headers.get('X-Umlaut'));
  console.log('RESULT visit=' + [window.freshValue, getComputedStyle(document.body).color.replace(/ /g, ''), text].join(','));
})();
</script>`;

// A large script (over the minimum size for the bytecode cache) with many functions; a part
// only runs on the second visit (addition in the cache)
let bigVersion = 1;
function bigScript() {
  let code = `var bigVersion = ${bigVersion};\n`;
  for (let i = 0; i < 120; i++)
    code += `function f${i}(x) { var s = 0; for (var k = 0; k < 10; k++) s += (x * ${i + 1} + k * bigVersion) % 97; return s + '${'abcdefgh'.repeat(2)}'.length; }\n`;
  code += `window.bigResult = function (all) { var t = 0; for (var i = 0; i < (all ? 120 : 60); i++) t += window['f' + i](i); return t; };\n`;
  return code;
}
const bytecodePage = (
  src,
) => `<!doctype html><title>Bytecode</title><script src="${src}"></script><body><script>
console.log('RESULT bc=' + bigVersion + ':' + bigResult(location.hash !== '#half'));
</script>`;
// Registers a service worker under /sw/ that answers /sw/app.js with fetch() of another URL
const SW_SETUP_PAGE = `<!doctype html><title>SW setup</title><body><script>
(async () => {
  await navigator.serviceWorker.register('/sw/worker.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  console.log('RESULT swready=1');
})();
</script>`;
const SW_SCRIPT = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).pathname === '/sw/app.js') e.respondWith(fetch('/sw-target.js'));
});`;

// An answer without a length that ends with the connection: the first time it hangs after a part
// until the test restarts the relay
const CUT_PAGE = `<!doctype html><title>Cut</title><body><script>
fetch('/cut.txt').then((r) => r.text()).then((t) => console.log('RESULT cut=ok:' + t), () => console.log('RESULT cut=error'));
</script>`;
let cutStarted;
const cutRequest = new Promise((resolve) => (cutStarted = resolve));

// Many large cacheable answers (for the cleanup)
const MANY_PAGE = `<!doctype html><title>Many</title><body><script>
(async () => {
  for (let i = 1; i <= 8; i++)
    await (await fetch('/blob/' + i)).arrayBuffer();
  console.log('RESULT many=1');
})();
</script>`;

const requests = { fresh: 0, etag: 0, etag304: 0, nostore: 0, umlaut: 0, cut: 0 };
const { url: siteURL } = await serve((req, res) => {
  switch (req.url) {
    case '/':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(PAGE);
    case '/fresh.js':
      requests.fresh++;
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=3600' })
        .end("window.freshValue = 'fresh';");
    case '/etag.css':
      requests.etag++;
      if (req.headers['if-none-match'] === '"v1"') {
        requests.etag304++;
        return res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'no-cache' }).end();
      }
      return res
        .writeHead(200, { 'Content-Type': 'text/css', ETag: '"v1"', 'Cache-Control': 'no-cache' })
        .end('body { color: rgb(1, 2, 3); }');
    case '/bc':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(bytecodePage('/big.js'));
    case '/bc-redirect':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(bytecodePage('/redirect.js'));
    case '/redirect.js':
      return res
        .writeHead(302, { Location: '/redirect-target.js', 'Cache-Control': 'no-store' })
        .end();
    case '/sw/setup':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(SW_SETUP_PAGE);
    case '/sw/page':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(bytecodePage('/sw/app.js'));
    case '/sw/worker.js':
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
        .end(SW_SCRIPT);
    case '/big.js':
    case '/redirect-target.js':
    case '/sw-target.js':
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
        .end(bigScript());
    case '/umlaut.txt':
      requests.umlaut++;
      return res
        .writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=3600',
          'X-Umlaut': 'grün',
        })
        .end('u');
    case '/cut':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(CUT_PAGE);
    case '/cut.txt':
      if (++requests.cut > 1)
        return res
          .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' })
          .end('whole');
      req.socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: max-age=3600\r\nConnection: close\r\n\r\npart',
      );
      cutStarted();
      return;
    case '/many':
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(MANY_PAGE);
    case '/nostore.txt':
      requests.nostore++;
      return res
        .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        .end(`net${requests.nostore}`);
    default:
      if (req.url.startsWith('/blob/'))
        return res
          .writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'max-age=3600',
          })
          .end(Buffer.alloc(2 << 20, Number(req.url.slice(6))));
      return res.writeHead(404).end();
  }
});

const stack = await startStack({ token: 'cache-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
const result = (key) => results.wait(key);
// Bytecode cache log lines per path of the key (engine/src/BytecodeCache.cpp). "too late": the
// answer of the Cache API only came after compiling (possible on slow runners, the page then
// runs correctly without the cache)
const bytecodeLines = { hit: new Map(), 'too late for': new Map(), 'broken entry': new Map() };
let bytecodeCommits = 0;
let bytecodeAnyLines = 0;
page.on('console', (msg) => {
  if (msg.text().includes('Bytecode cache:')) bytecodeAnyLines++;
  const line = msg.text().match(/Bytecode cache: (hit|too late for|broken entry) (\S+)/);
  if (line) {
    const counts = bytecodeLines[line[1]];
    const path = new URL(line[2]).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  // Statistics line after every store pass
  if (/Bytecode cache: \d+ hits/.test(msg.text())) bytecodeCommits++;
});
const hits = (path = '/big.js') => bytecodeLines.hit.get(path) ?? 0;
const late = (path = '/big.js') => bytecodeLines['too late for'].get(path) ?? 0;
const broken = (path = '/big.js') => bytecodeLines['broken entry'].get(path) ?? 0;

const appURL = (url, extra = {}) => stack.app({ url, persistent: '1', ...extra });
await openHost(page, appURL(siteURL));
const first = await result('visit');
check('first visit from the network', first === 'fresh,rgb(1,2,3),net1', String(first));
const umlautFromNetwork = results.get('umlaut');
check(
  'one request each',
  requests.fresh === 1 && requests.etag === 1 && requests.nostore === 1,
  JSON.stringify(requests),
);

// Storing is asynchronous, wait a moment, then reload the whole host page
await page.waitForTimeout(2000);
results.clear();
await page.reload();
const second = await result('visit');
check('second visit: contents right', second === 'fresh,rgb(1,2,3),net2', String(second));
check(
  'max-age: came from the cache (no new request)',
  requests.fresh === 1,
  JSON.stringify(requests),
);
check(
  'ETag: revalidated, 304',
  requests.etag === 2 && requests.etag304 === 1,
  JSON.stringify(requests),
);
check('no-store: from the network again', requests.nostore === 2, JSON.stringify(requests));
check('header with an umlaut: from the network', umlautFromNetwork === 'grün', umlautFromNetwork);
check(
  'header with an umlaut: the same from the cache',
  results.get('umlaut') === 'grün' && requests.umlaut === 1,
  `${results.get('umlaut')} ${JSON.stringify(requests)}`,
);

// An answer without a length, the relay fails in the middle: WebCore takes that as the end, so
// such answers never go into the cache (else the next time only the part would come)
results.clear();
await openHost(page, appURL(`${siteURL}cut`));
await cutRequest;
await stack.restartRelay();
check('cut by the relay ends the answer', (await result('cut')) !== null, results.get('cut'));
results.clear();
await openHost(page, appURL(`${siteURL}cut`));
check(
  'cut answer not in the cache',
  (await result('cut')) === 'ok:whole' && requests.cut === 2,
  `${results.get('cut')} ${requests.cut} requests`,
);

// Bytecode cache: compute the expectation with the same script directly in node
const expected = (version, all) => {
  let t = 0;
  for (let i = 0; i < (all ? 120 : 60); i++) {
    let s = 0;
    for (let k = 0; k < 10; k++) s += (i * (i + 1) + k * version) % 97;
    t += s + 16;
  }
  return `${version}:${t}`;
};
async function visitBytecode(path, extra = {}) {
  results.clear();
  await openHost(page, appURL(`${siteURL}${path}`, { log: '1', ...extra }));
  const commits = bytecodeCommits;
  const value = await result('bc');
  // Stored 5 s after loading (encoded only then), then asynchronously into the Cache API: wait
  // for the statistics line, not a fixed time
  const end = Date.now() + 40000;
  while (bytecodeCommits === commits && Date.now() < end) await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  return value;
}
const bc1 = await visitBytecode('bc#half');
check('bytecode: first visit', bc1 === expected(1, false), String(bc1));
check('bytecode: first visit without a hit', hits() === 0, `hits=${hits()}`);
const bc2 = await visitBytecode('bc');
check('bytecode: second visit, also new functions', bc2 === expected(1, true), String(bc2));
check(
  'bytecode: second visit from the cache',
  hits() + late() === 1,
  `hits=${hits()} too late=${late()}`,
);
const bc3 = await visitBytecode('bc');
check(
  'bytecode: third visit (with additions)',
  bc3 === expected(1, true) && hits() + late() === 2 && hits() >= 1,
  `${bc3} hits=${hits()} too late=${late()}`,
);
bigVersion = 2;
const bc4 = await visitBytecode('bc');
check('bytecode: changed script with the same URL', bc4 === expected(2, true), String(bc4));
const bc5 = await visitBytecode('bc');
check('bytecode: new bytecode afterwards', bc5 === expected(2, true), String(bc5));

// The key is the URL the page asked for: after a 302 and for a service worker answer with
// fetch() of another URL the second visit hits
for (const [name, path, key] of [
  ['after a redirect', 'bc-redirect', '/redirect.js'],
  ['service worker answer of another URL', 'sw/page', '/sw/app.js'],
]) {
  if (path.startsWith('sw/')) {
    results.clear();
    await openHost(page, appURL(`${siteURL}sw/setup`));
    check('bytecode: service worker controls', (await result('swready')) === '1');
  }
  const first = await visitBytecode(path);
  const second = await visitBytecode(path);
  check(
    `bytecode: ${name}, hit on the second visit`,
    first === expected(2, true) && second === expected(2, true) && hits(key) + late(key) === 1,
    `${first} ${second} hits=${hits(key)} too late=${late(key)}`,
  );
}

// Broken entries (changed through the Cache API of the host page) are rejected, the script
// runs from source and its bytecode is stored again
const editEntry = (edit) =>
  page.evaluate(async (edit) => {
    const name = (await caches.keys()).find((n) => n.startsWith('browserlite-bytecode-'));
    const cache = await caches.open(name);
    const request = (await cache.keys()).find((r) => decodeURIComponent(r.url).endsWith('/big.js'));
    const bytes = new Uint8Array(await (await cache.match(request)).arrayBuffer());
    // Header: magic, version, length (8 bytes from 8), checksum (8 bytes from 16)
    if (edit === 'checksum') bytes[16] ^= 1;
    await cache.put(
      request,
      new Response(edit === 'truncate' ? bytes.slice(0, bytes.length >> 1) : bytes),
    );
    return bytes.length;
  }, edit);
for (const edit of ['truncate', 'checksum']) {
  const before = { hits: hits(), broken: broken() };
  const size = await editEntry(edit);
  const value = await visitBytecode('bc');
  check(
    `bytecode: ${edit === 'truncate' ? 'truncated entry' : 'wrong checksum'} rejected`,
    value === expected(2, true) && broken() === before.broken + 1 && hits() === before.hits,
    `${value} size=${size} broken=${broken()} hits=${hits()}`,
  );
}
const takenBefore = hits() + late();
const healed = await visitBytecode('bc');
check(
  'bytecode: stored again after a broken entry',
  healed === expected(2, true) && hits() + late() === takenBefore + 1,
  `${healed} hits=${hits()} too late=${late()}`,
);

// Other JSC options: another build ID, so another cache (the old one goes away) and no hit
const bytecodeCaches = () =>
  page.evaluate(async () =>
    (await caches.keys()).filter((name) => name.startsWith('browserlite-bytecode-')),
  );
const plainCaches = await bytecodeCaches();
const hitsBefore = hits();
const withOption = await visitBytecode('bc', { env: 'JSC_dumpOptions=0' });
const optionCaches = await bytecodeCaches();
check(
  'bytecode: other JSC_* options, other cache name',
  withOption === expected(2, true) &&
    plainCaches.length === 1 &&
    optionCaches.length === 1 &&
    optionCaches[0].startsWith(`${plainCaches[0]}-jsc-`) &&
    hits() === hitsBefore,
  `${withOption} ${plainCaches} -> ${optionCaches} hits=${hits()}`,
);

// An empty BL_BUILD_ID turns the cache off (arm "bytecode cache off" of tests/perf)
results.clear();
const linesBefore = bytecodeAnyLines;
await openHost(page, appURL(`${siteURL}bc`, { log: '1', env: 'BL_BUILD_ID=' }));
const withoutCache = await result('bc');
await page.waitForTimeout(7000);
check(
  'bytecode: empty BL_BUILD_ID, no bytecode cache',
  withoutCache === expected(2, true) && bytecodeAnyLines === linesBefore,
  `${withoutCache} lines=${bytecodeAnyLines - linesBefore}`,
);

// Cleanup: with a 40 MB quota the limit is 10 MB, eight answers of 2 MB do not all fit, the
// oldest go away (own sizes, x-bl-size)
const small = await browser.newContext();
const smallPage = await small.newPage();
const cdp = await small.newCDPSession(smallPage);
await cdp.send('Storage.overrideQuotaForOrigin', { origin: stack.origin, quotaSize: 40 << 20 });
const smallResults = collect(smallPage);
await openHost(smallPage, appURL(`${siteURL}many`));
check('many large answers loaded', (await smallResults.wait('many')) === '1');
const readCache = () =>
  smallPage.evaluate(async () => {
    const cache = await caches.open('browserlite-http');
    const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const total = (await cache.matchAll()).reduce(
      (sum, response) => sum + Number(response.headers.get('x-bl-size')),
      0,
    );
    return { keys, total };
  });
let stored = await readCache();
for (let i = 0; i < 100 && !(stored.keys.includes('/blob/8') && stored.total <= 10 << 20); i++) {
  await smallPage.waitForTimeout(200);
  stored = await readCache();
}
check(
  'cleanup: under the limit, newest entry there, oldest gone',
  stored.total <= 10 << 20 && stored.keys.includes('/blob/8') && !stored.keys.includes('/blob/1'),
  JSON.stringify(stored),
);

await browser.close();
finish();
