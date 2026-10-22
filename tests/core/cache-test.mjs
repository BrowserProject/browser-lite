// HTTP cache of the engine (engine/src/HttpCache.cpp): after a reload of the whole host page (new
// engine, empty memory cache) fresh answers must come from the cache, answers with an ETag are
// revalidated (304), no-store always comes from the network. Also: headers with an umlaut are the
// same from the cache as from the network, an answer that only ends with the connection is not
// stored, and over the limit (with a small quota here) the oldest entries go away. Persistent
// storage (the cache needs it).
//
// The cache is partitioned by site like Chrome's HTTP cache (top site, frame site, subframe
// document): the same URL from another top site (localhost instead of 127.0.0.1, both reach the
// test server) misses, a cross-site iframe and the service worker it registered have their own
// partition, the background update of that worker and its navigation preload hit in theirs. A
// blob: top has the site of its creator, a CORS load after a cross-origin redirect (opaque origin
// in WebCore) and the dedicated and shared worker of the frame are keyed by their context, a
// sandboxed frame is not cached. Opening the HTTP cache deletes other formats,
// browser.storage.clearCaches() all of them.
//
// Range requests (206) like Chrome's sparse entries: ranges with a strong validator are stored,
// a range request hits only once the ranges cover the whole resource, a changed resource
// (other ETag after revalidation) replaces the old ranges, no validator or a weak ETag is not
// stored, Vary and the partition apply as for whole responses. A media element gets its pieces
// from the cache too (MediaFetch).
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
  wav,
} from '../lib/index.mjs';

timeLimit(2 * TIMEOUT + 420000);

const PAGE = `<!doctype html><title>Cache test</title><link rel=stylesheet href="/etag.css"><script src="/fresh.js"></script>
<body>Cache<script>
(async () => {
  const text = await (await fetch('/nostore.txt')).text();
  console.log('RESULT umlaut=' + (await fetch('/umlaut.txt')).headers.get('X-Umlaut'));
  console.log('RESULT visit=' + [window.freshValue, getComputedStyle(document.body).color.replace(/ /g, ''), text].join(','));
})();
</script>`;

// Partitions: the test server under another site (localhost) for the top page or a frame
const otherURL = () => siteURL.replace('127.0.0.1', 'localhost');
// A cacheable script of 127.0.0.1, loaded by a top page or a cross-site frame
const SITE_PAGE =
  () => `<!doctype html><title>Site</title><script src="${siteURL}shared.js"></script>
<body><script>console.log('RESULT site=' + window.sharedValue);</script>`;
// Top page of 127.0.0.1 with a frame of localhost (path from ?src=), which reports by postMessage
const EMBED_PAGE = (src) => `<!doctype html><title>Embed</title><body>
<script>addEventListener('message', (e) => console.log('RESULT ' + e.data));</script>
<iframe src="${otherURL()}${src.slice(1)}"></iframe>`;
const FRAME_PAGE =
  () => `<!doctype html><title>Frame</title><script src="${siteURL}shared.js"></script>
<body><script>parent.postMessage('frame=' + window.sharedValue, '*');</script>`;
// Service worker of the cross-site frame (scope /sw2/): answers /sw2/data with fetch() of another
// URL, navigations of /sw2/nav with the navigation preload
const SW2_SETUP_PAGE = `<!doctype html><title>SW2 setup</title><body><script>
(async () => {
  await navigator.serviceWorker.register('/sw2/worker.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  parent.postMessage('sw2ready=1', '*');
})().catch((e) => parent.postMessage('sw2ready=' + e, '*'));
</script>`;
const SW2_SCRIPT = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.navigationPreload.enable().then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const path = new URL(e.request.url).pathname;
  if (path === '/sw2/data') e.respondWith(fetch('/sw2-data.txt'));
  else if (path === '/sw2/nav' && e.request.mode === 'navigate') e.respondWith(e.preloadResponse);
});`;
const SW2_PAGE = `<!doctype html><title>SW2 page</title><body><script>
fetch('/sw2/data').then((r) => r.text()).then((t) => parent.postMessage('sw2data=' + t, '*'), (e) => parent.postMessage('sw2data=' + e, '*'));
</script>`;
// Top page of 127.0.0.1 or localhost that navigates to a blob: document with a frame of localhost
const BLOB_TOP_PAGE = () => {
  const blobPage = `<!doctype html><title>Blob top</title><body>
<script>addEventListener('message', (e) => console.log('RESULT ' + e.data));</script>
<iframe src="${otherURL()}bframe"></iframe>`;
  return `<!doctype html><title>Blob setup</title><body><script>
location.href = URL.createObjectURL(new Blob([${JSON.stringify(blobPage).replace(/<\//g, '<\\/')}], { type: 'text/html' }));
</script>`;
};
// fetch() through a cross-origin redirect (url of /cors-redir to /cors-data?n=<name> of the
// other site): WebCore loads the target with an opaque origin
const corsFetch = (from, to, name) =>
  `fetch('${from}cors-redir?to=' + encodeURIComponent('${to}cors-data?n=${name}'))`;
const CORS_PAGE = () => `<!doctype html><title>CORS</title><body><script>
${corsFetch(otherURL(), siteURL, 'doc')}.then((r) => r.text()).then((t) => console.log('RESULT cors=' + t), (e) => console.log('RESULT cors=' + e));
</script>`;
// Frame of localhost with a dedicated and a shared worker, each fetches /wk-data and through a
// cross-origin redirect
const WK_PAGE = `<!doctype html><title>Workers</title><body><script>
const results = {};
const report = (name, value) => {
  results[name] = value;
  if (results.d && results.s) parent.postMessage('wk=' + results.d + ';' + results.s, '*');
};
new Worker('/wk/dedicated.js').onmessage = (e) => report('d', e.data);
new SharedWorker('/wk/shared.js').port.onmessage = (e) => report('s', e.data);
</script>`;
const workerFetches = (name) => `const run = () =>
  Promise.all([fetch('/wk-data?n=${name}'), ${corsFetch(siteURL, otherURL(), name)}].map((p) => p.then((r) => r.text())))
    .then((t) => t.join(','), (e) => String(e));`;
const DEDICATED_SCRIPT = () => `${workerFetches('d')}
run().then((v) => postMessage(v));`;
const SHARED_SCRIPT = () => `${workerFetches('s')}
onconnect = (e) => run().then((v) => e.ports[0].postMessage(v));`;
// Top page of 127.0.0.1 with a frame of localhost sandboxed without allow-same-origin (opaque
// origin), which loads a cacheable script
const SANDBOX_PAGE = () => `<!doctype html><title>Sandbox</title><body>
<script>addEventListener('message', (e) => console.log('RESULT ' + e.data));</script>
<iframe sandbox="allow-scripts" src="${otherURL()}sbframe"></iframe>`;
const SANDBOX_FRAME =
  () => `<!doctype html><title>Sandboxed</title><script src="${otherURL()}sb.js"></script>
<body><script>parent.postMessage('sb=' + window.sbValue, '*');</script>`;

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

// Range requests: fetch() of two halves (bytes=0-499, bytes=500-) or only the first of resources
// of 1000 bytes under /r/ with different headers; reports status, length and the first three
// characters (the version) per resource. Absolute URLs of 127.0.0.1, so a top page of
// localhost loads the same resources in its own partition
const RANGE_FILES = { full: 2, part: 1, ver: 2, nov: 2, weak: 2, vary: 2 };
const RANGE_PAGE = (variant, names) => `<!doctype html><title>Ranges</title><body><script>
(async () => {
  const out = {};
  for (const name of ${JSON.stringify(names)}) {
    const statuses = [];
    let text = '';
    for (const range of ['bytes=0-499', 'bytes=500-'].slice(0, ${JSON.stringify(RANGE_FILES)}[name])) {
      const response = await fetch('${siteURL}r/' + name, { headers: { Range: range, 'X-Variant': '${variant}' } });
      statuses.push(response.status);
      text += await response.text();
    }
    out[name] = statuses.join('/') + ',' + text.length + ',' + text.slice(0, 3);
  }
  console.log('RESULT ranges=' + JSON.stringify(out));
})().catch((e) => console.log('RESULT ranges=' + e));
</script>`;
const rangeBody = (version) => Buffer.from(`${version}:`.padEnd(1000, '0123456789'));
// Version of /r/ver (changed between visits) and the requests per resource: range and If-None-Match
let verVersion = 'v1';
let rangeRequests = [];
function serveRange(req, res, data, headers) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (!match)
    return res
      .writeHead(200, { ...headers, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' })
      .end(data);
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : data.length - 1, data.length - 1);
  res
    .writeHead(206, {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
    })
    .end(data.subarray(start, end + 1));
}
// Media: an audio file of 30 s (about 2.6 MB, two pieces of the service worker), cacheable
const LOOP = wav(30, { rate: 44100 });
const MEDIA_PAGE = `<!doctype html><title>Media</title><body>
<audio id="audio" src="/r/loop.wav" muted preload="auto"></audio><script>
const audio = document.getElementById('audio');
audio.addEventListener('loadedmetadata', () => console.log('RESULT media=' + Math.round(audio.duration)));
audio.addEventListener('error', () => console.log('RESULT media=error ' + (audio.error && audio.error.code)));
</script>`;

const requests = { fresh: 0, etag: 0, etag304: 0, nostore: 0, umlaut: 0, cut: 0 };
// Partitions: requests per path, the worker script with its If-None-Match (none: '-'), the
// navigation with its preload header
const partitionRequests = {
  shared: 0,
  frame: 0,
  sw2Data: 0,
  sw2Script: [],
  sw2Nav: [],
  bframe: 0,
  cors: {},
  wk: {},
  sbFrame: 0,
  sbScript: 0,
};
const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const cacheable = (type) => ({ 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
const count = (counts, name) => {
  counts[name] = (counts[name] ?? 0) + 1;
};
const { url: siteURL } = await serve((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/r/')) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, X-Variant',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const name = pathname.slice(3);
    const inm = req.headers['if-none-match'];
    rangeRequests.push(`${name}:${req.headers.range || '-'}:${inm || '-'}`);
    cors['Content-Type'] = 'text/plain';
    const max = { ...cors, 'Cache-Control': 'max-age=3600' };
    switch (name) {
      case 'full':
        return serveRange(req, res, rangeBody('f1'), { ...max, ETag: '"f1"' });
      case 'part':
        return serveRange(req, res, rangeBody('p1'), { ...max, ETag: '"p1"' });
      case 'ver': {
        const headers = { ...cors, 'Cache-Control': 'no-cache', ETag: `"${verVersion}"` };
        if (inm === `"${verVersion}"`) return res.writeHead(304, headers).end();
        return serveRange(req, res, rangeBody(verVersion), headers);
      }
      case 'nov':
        return serveRange(req, res, rangeBody('n1'), max);
      case 'weak':
        return serveRange(req, res, rangeBody('w1'), { ...max, ETag: 'W/"w1"' });
      case 'vary': {
        const variant = `y${req.headers['x-variant']}`;
        return serveRange(req, res, rangeBody(variant), {
          ...max,
          ETag: `"${variant}"`,
          Vary: 'X-Variant',
        });
      }
      case 'loop.wav':
        return serveRange(req, res, LOOP, {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'max-age=3600',
          ETag: '"l1"',
        });
    }
    return res.writeHead(404).end();
  }
  switch (pathname) {
    case '/rangepage':
      return res
        .writeHead(200, html)
        .end(RANGE_PAGE(searchParams.get('variant'), searchParams.get('names').split(',')));
    case '/mediapage':
      return res.writeHead(200, html).end(MEDIA_PAGE);
    case '/blobtop':
      return res.writeHead(200, html).end(BLOB_TOP_PAGE());
    case '/bframe':
      partitionRequests.bframe++;
      return res
        .writeHead(200, cacheable('text/html; charset=utf-8'))
        .end(
          `<!doctype html><title>B</title><script>parent.postMessage('bframe=1', '*');</script>`,
        );
    case '/cors':
      return res.writeHead(200, html).end(CORS_PAGE());
    case '/cors-redir':
      return res
        .writeHead(302, {
          Location: searchParams.get('to'),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        .end();
    case '/cors-data':
      count(partitionRequests.cors, searchParams.get('n'));
      return res
        .writeHead(200, { ...cacheable('text/plain'), 'Access-Control-Allow-Origin': '*' })
        .end(searchParams.get('n'));
    case '/wk/page':
      return res.writeHead(200, html).end(WK_PAGE);
    case '/wk/dedicated.js':
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
        .end(DEDICATED_SCRIPT());
    case '/wk/shared.js':
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
        .end(SHARED_SCRIPT());
    case '/wk-data':
      count(partitionRequests.wk, searchParams.get('n'));
      return res.writeHead(200, cacheable('text/plain')).end(`w${searchParams.get('n')}`);
    case '/sandboxed':
      return res.writeHead(200, html).end(SANDBOX_PAGE());
    case '/sbframe':
      partitionRequests.sbFrame++;
      return res.writeHead(200, cacheable('text/html; charset=utf-8')).end(SANDBOX_FRAME());
    case '/sb.js':
      partitionRequests.sbScript++;
      return res.writeHead(200, cacheable('text/javascript')).end("window.sbValue = 'sb';");
    case '/site':
      return res.writeHead(200, html).end(SITE_PAGE());
    case '/shared.js':
      partitionRequests.shared++;
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=3600' })
        .end("window.sharedValue = 'shared';");
    case '/embed':
      return res.writeHead(200, html).end(EMBED_PAGE(searchParams.get('src')));
    case '/frame':
      partitionRequests.frame++;
      return res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'max-age=3600',
        })
        .end(FRAME_PAGE());
    case '/sw2/setup':
      return res.writeHead(200, html).end(SW2_SETUP_PAGE);
    case '/sw2/page':
      return res.writeHead(200, html).end(SW2_PAGE);
    case '/sw2/worker.js': {
      const etag = req.headers['if-none-match'];
      partitionRequests.sw2Script.push(etag || '-');
      if (etag === '"w1"')
        return res.writeHead(304, { ETag: '"w1"', 'Cache-Control': 'no-cache' }).end();
      return res
        .writeHead(200, {
          'Content-Type': 'text/javascript',
          ETag: '"w1"',
          'Cache-Control': 'no-cache',
        })
        .end(SW2_SCRIPT);
    }
    case '/sw2-data.txt':
      partitionRequests.sw2Data++;
      return res
        .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' })
        .end('swdata');
    case '/sw2/nav': {
      const header = req.headers['service-worker-navigation-preload'] || 'none';
      partitionRequests.sw2Nav.push(header);
      return res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'max-age=3600',
        })
        .end(
          `<!doctype html><title>Nav</title><script>parent.postMessage('sw2nav=${header}', '*');</script>`,
        );
    }
  }
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

const appURL = (url) => stack.app({ url, persistent: '1' });
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

// Partitions of the HTTP cache. Each visit starts a new engine (empty memory cache, which is
// shared by all sites inside one engine); storing is asynchronous, so wait a moment after it
const HTTP_CACHE = 'browserlite-http-v2';
const httpEntries = () =>
  page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => {
      const fields = new URL(request.url).searchParams;
      return { p: fields.get('p'), u: fields.get('u'), v: fields.get('v') };
    });
  }, HTTP_CACHE);
const partitionsOf = async (url) =>
  (await httpEntries())
    .filter((entry) => entry.u === url)
    .map((entry) => entry.p)
    .sort()
    .join('|');
async function visit(url, key) {
  results.clear();
  await openHost(page, appURL(url));
  const value = await result(key);
  await page.waitForTimeout(2000);
  return value;
}
const sharedURL = `${siteURL}shared.js`;
const counts = () => JSON.stringify(partitionRequests);
let value = await visit(`${siteURL}site`, 'site');
check(
  'partition: first top site from the network',
  value === 'shared' && partitionRequests.shared === 1,
  `${value} ${counts()}`,
);
value = await visit(`${otherURL()}site`, 'site');
check(
  'partition: same URL from another top site misses',
  value === 'shared' && partitionRequests.shared === 2,
  `${value} ${counts()}`,
);
value = await visit(`${siteURL}site`, 'site');
check(
  'partition: same URL from the same top site hits',
  value === 'shared' && partitionRequests.shared === 2,
  `${value} ${counts()}`,
);
value = await visit(`${siteURL}embed?src=/frame`, 'frame');
check(
  'partition: cross-site frame has its own partition',
  value === 'shared' && partitionRequests.shared === 3 && partitionRequests.frame === 1,
  `${value} ${counts()}`,
);
value = await visit(`${siteURL}embed?src=/frame`, 'frame');
check(
  'partition: cross-site frame and its document hit in their partition',
  value === 'shared' && partitionRequests.shared === 3 && partitionRequests.frame === 1,
  `${value} ${counts()}`,
);
const sharedPartitions = await partitionsOf(sharedURL);
check(
  'partition: keys of the script (top site, frame site)',
  sharedPartitions ===
    'http://127.0.0.1 http://127.0.0.1|http://127.0.0.1 http://localhost|http://localhost http://localhost',
  sharedPartitions,
);
const framePartitions = await partitionsOf(`${otherURL()}frame`);
check(
  'partition: key of the frame document (subframe document)',
  framePartitions === 's_http://127.0.0.1 http://localhost',
  framePartitions,
);

// Service worker of the cross-site frame. First the frame navigates to /sw2/nav without a worker
// (stored in the partition of a subframe document), then registers the worker. Its fetch()
// stores and hits in the partition of the frame (top site 127.0.0.1, worker site localhost),
// the background update after a navigation revalidates the script stored by the registration
// (If-None-Match), the navigation preload takes /sw2/nav fresh from the subframe partition
value = await visit(`${siteURL}embed?src=/sw2/nav`, 'sw2nav');
check(
  'service worker partition: frame navigation without a worker',
  value === 'none' && partitionRequests.sw2Nav.join() === 'none',
  `${value} ${counts()}`,
);
value = await visit(`${siteURL}embed?src=/sw2/setup`, 'sw2ready');
check(
  'service worker partition: registered in the cross-site frame',
  value === '1' && partitionRequests.sw2Script.join() === '-',
  `${value} ${counts()}`,
);
const scriptFetches = partitionRequests.sw2Script.length;
value = await visit(`${siteURL}embed?src=/sw2/page`, 'sw2data');
check(
  'service worker partition: fetch() of the worker from the network',
  value === 'swdata' && partitionRequests.sw2Data === 1,
  `${value} ${counts()}`,
);
for (let i = 0; i < 100 && partitionRequests.sw2Script.length === scriptFetches; i++)
  await page.waitForTimeout(200);
check(
  'service worker partition: background update revalidates in the partition of the registration',
  partitionRequests.sw2Script.slice(scriptFetches).join() === '"w1"',
  counts(),
);
value = await visit(`${siteURL}embed?src=/sw2/page`, 'sw2data');
check(
  'service worker partition: fetch() of the worker hits in the partition of the frame',
  value === 'swdata' && partitionRequests.sw2Data === 1,
  `${value} ${counts()}`,
);
const workerPartitions = await partitionsOf(`${otherURL()}sw2-data.txt`);
check(
  'service worker partition: key of the worker fetch',
  workerPartitions === 'http://127.0.0.1 http://localhost',
  workerPartitions,
);
value = await visit(`${siteURL}embed?src=/sw2/nav`, 'sw2nav');
check(
  'service worker partition: navigation preload hits in the subframe partition',
  value === 'none' && partitionRequests.sw2Nav.join() === 'none',
  `${value} ${counts()}`,
);

// A blob: top document has the site of its creator: the same frame under blob: tops of two
// sites misses, and hits again under the first
const bframeURL = `${otherURL()}bframe`;
for (const [name, base, want] of [
  ['first creator from the network', siteURL, 1],
  ['other creator misses', otherURL(), 2],
  ['same creator hits', siteURL, 2],
]) {
  value = await visit(`${base}blobtop`, 'bframe');
  check(
    `blob: top partition: ${name}`,
    value === '1' && partitionRequests.bframe === want,
    `${value} ${counts()}`,
  );
}
const blobPartitions = await partitionsOf(bframeURL);
check(
  'blob: top partition: keys of the frame document',
  blobPartitions === 's_http://127.0.0.1 http://localhost|s_http://localhost http://localhost',
  blobPartitions,
);

// After a cross-origin redirect WebCore loads with an opaque origin: the document's site
// decides, so the target is stored and hits
for (const name of ['from the network', 'hits']) {
  value = await visit(`${siteURL}cors`, 'cors');
  check(
    `redirected CORS partition: ${name}`,
    value === 'doc' && partitionRequests.cors.doc === 1,
    `${value} ${counts()}`,
  );
}
const corsPartitions = await partitionsOf(`${siteURL}cors-data?n=doc`);
check(
  'redirected CORS partition: key of the document',
  corsPartitions === 'http://127.0.0.1 http://127.0.0.1',
  corsPartitions,
);

// Dedicated and shared worker of the cross-site frame: partition of the frame (top site
// 127.0.0.1, worker site localhost), also after a cross-origin redirect
for (const name of ['from the network', 'hit']) {
  value = await visit(`${siteURL}embed?src=/wk/page`, 'wk');
  check(
    `worker partition: ${name}`,
    value === 'wd,d;ws,s' &&
      partitionRequests.wk.d === 1 &&
      partitionRequests.wk.s === 1 &&
      partitionRequests.cors.d === 1 &&
      partitionRequests.cors.s === 1,
    `${value} ${counts()}`,
  );
}
const workerKeys = [];
for (const url of ['wk-data?n=d', 'wk-data?n=s', 'cors-data?n=d', 'cors-data?n=s'])
  workerKeys.push(await partitionsOf(`${otherURL()}${url}`));
check(
  'worker partition: keys of dedicated and shared worker',
  workerKeys.every((key) => key === 'http://127.0.0.1 http://localhost'),
  workerKeys.join('|'),
);

// A frame sandboxed without allow-same-origin has an opaque origin: neither its document nor
// its script is stored
for (const visits of [1, 2]) {
  value = await visit(`${siteURL}sandboxed`, 'sb');
  check(
    `sandboxed frame not cached (visit ${visits})`,
    value === 'sb' && partitionRequests.sbFrame === visits && partitionRequests.sbScript === visits,
    `${value} ${counts()}`,
  );
}
const sandboxKeys =
  (await partitionsOf(`${otherURL()}sbframe`)) + (await partitionsOf(`${otherURL()}sb.js`));
check('sandboxed frame: no entries', sandboxKeys === '', sandboxKeys);

// Range requests. Visit 1 stores, visit 2 (other Vary value, /r/ver changed) and visit 3 hit or
// revalidate, visit 4 from a top page of localhost is another partition
async function rangeVisit(top, variant, names = Object.keys(RANGE_FILES)) {
  rangeRequests = [];
  const value = await visit(`${top}rangepage?variant=${variant}&names=${names}`, 'ranges');
  let got = {};
  try {
    got = JSON.parse(value);
  } catch {}
  const requestsOf = (name) => rangeRequests.filter((r) => r.startsWith(`${name}:`));
  return { got, requestsOf, info: `${value} ${rangeRequests.join(' ')}` };
}
const whole = (version) => `206/206,1000,${version}:`;
let ranges = await rangeVisit(siteURL, 'a');
check(
  'range: first visit from the network',
  ranges.got.full === whole('f1') &&
    ranges.got.part === '206,500,p1:' &&
    ranges.got.ver === whole('v1') &&
    ranges.got.nov === whole('n1') &&
    ranges.got.weak === whole('w1') &&
    ranges.got.vary === whole('ya') &&
    Object.entries(RANGE_FILES).every(([name, parts]) => ranges.requestsOf(name).length === parts),
  ranges.info,
);
verVersion = 'v2';
ranges = await rangeVisit(siteURL, 'b');
check(
  'range: complete resource from the cache',
  ranges.got.full === whole('f1') && ranges.requestsOf('full').length === 0,
  ranges.info,
);
check(
  'range: incomplete resource from the network',
  ranges.got.part === '206,500,p1:' && ranges.requestsOf('part').length === 1,
  ranges.info,
);
// The second request may still find the old ranges (storing is asynchronous)
check(
  'range: changed resource revalidated with the stored ETag, new content',
  ranges.got.ver === whole('v2') &&
    ranges.requestsOf('ver')[0] === 'ver:bytes=0-499:"v1"' &&
    ranges.requestsOf('ver').length === 2,
  ranges.info,
);
const verVersions = (await httpEntries())
  .filter((entry) => entry.u === `${siteURL}r/ver`)
  .map((entry) => entry.v);
check(
  'range: changed resource replaces the stored ranges',
  verVersions.length === 2 && verVersions.every((v) => v?.startsWith('"v2"')),
  JSON.stringify(verVersions),
);
check(
  'range: no validator or a weak ETag is not stored',
  ranges.got.nov === whole('n1') &&
    ranges.got.weak === whole('w1') &&
    ranges.requestsOf('nov').length === 2 &&
    ranges.requestsOf('weak').length === 2,
  ranges.info,
);
check(
  'range: other Vary value from the network',
  ranges.got.vary === whole('yb') && ranges.requestsOf('vary').length === 2,
  ranges.info,
);
ranges = await rangeVisit(siteURL, 'b');
check(
  'range: revalidated with the stored ETag, 304 from the cache',
  ranges.got.ver === whole('v2') &&
    ranges.requestsOf('ver').join() === 'ver:bytes=0-499:"v2",ver:bytes=500-:"v2"',
  ranges.info,
);
check(
  'range: same Vary value from the cache',
  ranges.got.vary === whole('yb') && ranges.requestsOf('vary').length === 0,
  ranges.info,
);
ranges = await rangeVisit(otherURL(), 'b', ['full']);
check(
  'range: other partition from the network',
  ranges.got.full === whole('f1') && ranges.requestsOf('full').length === 2,
  ranges.info,
);

// Media: the service worker loads the audio in pieces through MediaFetch; once all pieces are
// stored the next visit takes them from the cache
rangeRequests = [];
const loopEnd = `-${LOOP.length - 1}:`;
let media = await visit(`${siteURL}mediapage`, 'media');
for (let i = 0; i < 150 && !rangeRequests.some((r) => r.includes(loopEnd)); i++)
  await page.waitForTimeout(200);
await page.waitForTimeout(2000);
const loopFromNetwork = rangeRequests.filter((r) => r.startsWith('loop.wav:'));
check(
  'media: first visit in pieces from the network',
  media === '30' && loopFromNetwork.length >= 2 && loopFromNetwork.some((r) => r.includes(loopEnd)),
  `${media} ${loopFromNetwork.join(' ')}`,
);
rangeRequests = [];
media = await visit(`${siteURL}mediapage`, 'media');
await page.waitForTimeout(3000);
check(
  'media: second visit from the cache',
  media === '30' && !rangeRequests.some((r) => r.startsWith('loop.wav:')),
  `${media} ${rangeRequests.join(' ')}`,
);

// Other formats of the HTTP cache: deleted when the engine opens the cache, and
// browser.storage.clearCaches() deletes all formats
const httpCaches = () =>
  page.evaluate(async () =>
    (await caches.keys()).filter(
      (name) => name === 'browserlite-http' || name.startsWith('browserlite-http-'),
    ),
  );
const addOldFormats = () =>
  page.evaluate(async () => {
    for (const name of ['browserlite-http', 'browserlite-http-v1'])
      await (await caches.open(name)).put('https://old.invalid/', new Response('old'));
  });
await addOldFormats();
const withOld = await httpCaches();
await visit(`${siteURL}site`, 'site');
const afterOpen = await httpCaches();
check(
  'other formats deleted when opening',
  withOld.length === 3 && afterOpen.join() === HTTP_CACHE,
  `${withOld} -> ${afterOpen}`,
);
await addOldFormats();
await page.evaluate(() => window.blTest.browser.storage.clearCaches());
const afterClear = await httpCaches();
check('clearCaches() deletes all formats', afterClear.length === 0, afterClear.join());

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
  smallPage.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = (await cache.keys()).map(
      (request) => new URL(new URL(request.url).searchParams.get('u')).pathname,
    );
    const total = (await cache.matchAll()).reduce(
      (sum, response) => sum + Number(response.headers.get('x-bl-size')),
      0,
    );
    return { keys, total };
  }, HTTP_CACHE);
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
