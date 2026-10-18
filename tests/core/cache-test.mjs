// HTTP cache of the engine (engine/src/HttpCache.cpp): after a reload of the whole host page (new
// engine, empty memory cache) fresh answers must come from the cache, answers with an ETag are
// revalidated (304), no-store always comes from the network. Also the bytecode cache
// (engine/src/BytecodeCache.cpp): a large script comes as finished bytecode on the second visit,
// a changed script under the same URL must not take the old bytecode. Also: headers with an
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

timeLimit(2 * TIMEOUT + 120000);

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
const BC_PAGE = `<!doctype html><title>Bytecode</title><script src="/big.js"></script><body><script>
console.log('RESULT bc=' + bigVersion + ':' + bigResult(location.hash !== '#half'));
</script>`;

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
        .end(BC_PAGE);
    case '/big.js':
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
// "too late": the answer of the Cache API only came after compiling (possible on slow runners,
// the page then runs correctly without the cache)
let bytecodeHits = 0;
let bytecodeLate = 0;
let bytecodeCommits = 0;
page.on('console', (msg) => {
  if (msg.text().includes('Bytecode cache: hit') && msg.text().includes('/big.js')) bytecodeHits++;
  if (msg.text().includes('Bytecode cache: too late') && msg.text().includes('/big.js'))
    bytecodeLate++;
  // Statistics line after every store pass (engine/src/BytecodeCache.cpp)
  if (/Bytecode cache: \d+ hits/.test(msg.text())) bytecodeCommits++;
});

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
async function visitBytecode(hash) {
  results.clear();
  await openHost(page, appURL(`${siteURL}bc${hash}`, { log: '1' }));
  const commits = bytecodeCommits;
  const value = await result('bc');
  // Stored 5 s after loading (encoded only then), then asynchronously into the Cache API: wait
  // for the statistics line, not a fixed time
  const end = Date.now() + 40000;
  while (bytecodeCommits === commits && Date.now() < end) await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  return value;
}
const bc1 = await visitBytecode('#half');
check('bytecode: first visit', bc1 === expected(1, false), String(bc1));
check('bytecode: first visit without a hit', bytecodeHits === 0, `hits=${bytecodeHits}`);
const bc2 = await visitBytecode('');
check('bytecode: second visit, also new functions', bc2 === expected(1, true), String(bc2));
check(
  'bytecode: second visit from the cache',
  bytecodeHits + bytecodeLate === 1,
  `hits=${bytecodeHits} too late=${bytecodeLate}`,
);
const bc3 = await visitBytecode('');
check(
  'bytecode: third visit (with additions)',
  bc3 === expected(1, true) && bytecodeHits + bytecodeLate === 2 && bytecodeHits >= 1,
  `${bc3} hits=${bytecodeHits} too late=${bytecodeLate}`,
);
bigVersion = 2;
const bc4 = await visitBytecode('');
check('bytecode: changed script with the same URL', bc4 === expected(2, true), String(bc4));
const bc5 = await visitBytecode('');
check('bytecode: new bytecode afterwards', bc5 === expected(2, true), String(bc5));

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
