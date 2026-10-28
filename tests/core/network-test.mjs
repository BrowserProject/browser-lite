// Network through the whole chain in a real Chromium:
//
//   host page (@browser-lite/core) -> engine (WASM) -> curl -> engine sockets -> Wisp -> relay -> test server
//
// The test server delivers a page through a redirect, sets a cookie, loads a script and a gzip
// response with fetch(); the script writes everything into the title. Then the failures: bad
// certificates (self-signed, wrong name, expired), refused connection, unknown name, failing
// navigations (error page with reason, reload, back, the view keeps the address), Safari's HTTP/2
// settings and request headers (#283), many hanging
// connections (limit of curl) and a relay that restarts during the session (also
// navigator.onLine and the error page "No connection" that reloads itself, a form only after
// "Resend"). Last, reasons only a stand-in relay delivers reliably (no answer, blocked, address
// unreachable). Also the favicon (icon event) and the GPU context loss of the engine.
//
//   node tests/core/network-test.mjs [engine-dir]
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { makeCerts } from '../fixtures/certs.mjs';
import {
  SWIFTSHADER,
  TIMEOUT,
  buildDir,
  check,
  finish,
  freePort,
  launch,
  load,
  openHost,
  pagePixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

// ------------------------------------------------------------ test server

const PAGE = `<!doctype html>
<html><head><title>loading</title><link rel="icon" href="/icon.svg">
<style>body{margin:0;background:#fff} #box{position:absolute;left:20px;top:20px;width:100px;height:100px;background:#e00000}</style>
</head><body><div id="box"></div><p style="margin-top:140px">Network test</p>
<script src="/script.js"></script></body></html>`;

const SCRIPT = `
function webSocketEcho() {
  return new Promise((resolve) => {
    const socket = new WebSocket('ws://' + location.host + '/echo');
    const timer = setTimeout(() => resolve('ws-timeout'), 20000);
    socket.onopen = () => socket.send('ping-äöü');
    socket.onmessage = (event) => { clearTimeout(timer); resolve('ws:' + event.data); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); resolve('ws-error'); };
  });
}
async function webSocketStreamEcho() {
  if (typeof WebSocketStream !== 'function')
    return 'wss-missing';
  try {
    const stream = new WebSocketStream('ws://' + location.host + '/echo');
    const { readable, writable } = await stream.opened;
    const writer = writable.getWriter();
    await writer.write('stream');
    const { value } = await readable.getReader().read();
    stream.close();
    const closed = await stream.closed;
    return 'wsstream:' + value + ':' + closed.closeCode;
  } catch (e) {
    return 'wsstream-error:' + e.name;
  }
}
function secure() {
  // HTTPS and WSS against the local TLS server (test CA through window.blTestOptions)
  return fetch(SECURE.good + '/secure.txt').then((r) => r.text()).then((text) => new Promise((resolve) => {
    const socket = new WebSocket(SECURE.good.replace('https', 'wss') + '/echo');
    const timer = setTimeout(() => resolve(text.trim() + ',wss-timeout'), 20000);
    socket.onopen = () => socket.send('tls');
    socket.onmessage = (event) => { clearTimeout(timer); resolve(text.trim() + ',' + event.data); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); resolve(text.trim() + ',wss-error'); };
  }), (e) => 'https-error');
}
fetch('/data.txt').then((r) => r.text()).then(async (text) => {
  const ws = await webSocketEcho();
  const wsStream = await webSocketStreamEcho();
  const tls = await secure();
  const video = document.createElement('video');
  const media = video instanceof HTMLMediaElement && typeof video.pause === 'function' ? 'media-ok' : 'media-missing';
  document.title = 'E2E|' + document.cookie + '|' + text.trim() + '|' + ws + '|' + tls + '|' + wsStream + '|' + media;
}, (e) => { document.title = 'E2E|fetch-error|' + e; });
`;

// Failures: every request ends with "ok:<text>" or "refused:<error>", never with the time limit.
// The good TLS server is the counter check in the same run.
const NEGATIVE = `<!doctype html><title>loading</title><body>Failures<script>
const attempt = (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  return fetch(url, { signal: controller.signal }).then((r) => r.text()).then((text) => 'ok:' + text.trim(),
    (e) => controller.signal.aborted ? 'timeout' : 'refused:' + e.name).finally(() => clearTimeout(timer));
};
const socket = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const timer = setTimeout(() => resolve('timeout'), 20000);
  ws.onopen = () => { clearTimeout(timer); resolve('open'); ws.close(); };
  ws.onerror = () => { clearTimeout(timer); resolve('refused'); };
});
(async () => {
  const out = [];
  for (const [name, url] of NEGATIVE_URLS)
    out.push(name + '=' + await attempt(url));
  out.push('wss-self=' + await socket(SECURE.selfSigned.replace('https', 'wss') + '/echo'));
  document.title = 'NEG|' + out.join('|');
})();
</script>`;

// Many hanging requests (long polls) to several servers: another request must still go through.
// WebKit alone allows curl only 17 connections.
const POOL = `<!doctype html><title>loading</title><body>Connections<script>
(async () => {
  const hanging = new AbortController();
  for (const url of HANG_URLS)
    fetch(url, { mode: 'no-cors', signal: hanging.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const result = await fetch(FREE_URL, { mode: 'no-cors', signal: controller.signal }).then(() => 'ok', () => 'timeout');
  clearTimeout(timer);
  hanging.abort();
  document.title = 'POOL|' + result;
})();
</script>`;

const requests = [];
let secureURLs = null;
let poolScript = '';
// Port without a server: the connection is refused (WebKit already blocks port 1)
const closedURL = `http://127.0.0.1:${await freePort()}/`;
const { server: site, url: siteRoot } = await serve((req, res) => {
  requests.push(req.url);
  const secureScript = () => `const SECURE = ${JSON.stringify(secureURLs)};\n`;
  switch (req.url) {
    case '/start':
      res.writeHead(302, { Location: '/page' }).end();
      break;
    case '/page':
      res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'bl=1; Path=/',
        })
        .end(PAGE);
      break;
    case '/icon.svg':
      res
        .writeHead(200, { 'Content-Type': 'image/svg+xml' })
        .end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0a0"/></svg>',
        );
      break;
    case '/script.js':
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(secureScript() + SCRIPT);
      break;
    case '/pool':
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(POOL.replace('<script>', `<script>${poolScript}`));
      break;
    case '/free':
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('free');
      break;
    case '/form':
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          '<title>FORM|</title><form method="post" action="/sent"><input name="field" value="value"></form>',
        );
      break;
    case '/sent': {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () =>
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<title>SENT|${req.method}|${body}</title>`),
      );
      break;
    }
    case '/negative': {
      const urls = [
        ['good', `${secureURLs.good}/secure.txt`],
        ['self', `${secureURLs.selfSigned}/`],
        ['name', `${secureURLs.wrongName}/`],
        ...(secureURLs.expired ? [['expired', `${secureURLs.expired}/`]] : []),
        ['refused', closedURL],
        ['dns', 'http://nonexistent.invalid/'],
      ];
      const script = `${secureScript()}const NEGATIVE_URLS = ${JSON.stringify(urls)};\n`;
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(NEGATIVE.replace('<script>', `<script>${script}`));
      break;
    }
    case '/data.txt': {
      const gz = (req.headers['accept-encoding'] || '').includes('gzip');
      const body = Buffer.from('hello-gzip\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      });
      res.end(gz ? zlib.gzipSync(body) : body);
      break;
    }
    default:
      res.writeHead(404).end();
  }
});
const siteURL = siteRoot.slice(0, -1);
// WebSocket echo of the test page (WebSockets of the guest page also go through Wisp)
const echo = new WebSocketServer({ noServer: true });
echo.on('connection', (socket) =>
  socket.on('message', (data) => socket.send(`echo:${data.toString()}`)),
);
site.on('upgrade', (req, socket, head) => {
  if (req.url === '/echo')
    echo.handleUpgrade(req, socket, head, (ws) => echo.emit('connection', ws, req));
  else socket.destroy();
});

// TLS servers with an own test CA: TLS in the engine (OpenSSL in WASM), HTTPS and WSS. The CA
// reaches the engine through window.blTestOptions (engine.extraCA). Plus servers with
// certificates the engine must reject.
const certs = makeCerts(path.join(buildDir, 'e2e-certs'));

async function secureServer(credentials, label) {
  const server = https.createServer(credentials, (req, res) => {
    requests.push(`${label}:${req.url}`);
    res
      .writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      .end('tls-ok\n');
  });
  const secureEcho = new WebSocketServer({ server, path: '/echo' });
  secureEcho.on('connection', (socket) =>
    socket.on('message', (data) => socket.send(`wss:${data.toString()}`)),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `https://127.0.0.1:${server.address().port}`;
}
secureURLs = {
  good: await secureServer(certs.good, 'https'),
  selfSigned: await secureServer(certs.selfSigned, 'self'),
  wrongName: await secureServer(certs.wrongName, 'name'),
  expired: certs.expired ? await secureServer(certs.expired, 'expired') : null,
};

// HTTP/2 server with the good certificate: the engine's SETTINGS and the headers of a navigation
const h2 = { settings: null, headers: [] };
const h2Server = http2.createSecureServer({ ...certs.good, allowHTTP1: true });
h2Server.on('session', (session) =>
  session.once('remoteSettings', (settings) => {
    h2.settings ??= settings;
  }),
);
h2Server.on('stream', (stream, headers, flags, rawHeaders) => {
  if (headers[':path'] === '/fingerprint') h2.headers = rawHeaders;
  stream.respond({ ':status': 200, 'content-type': 'text/html' });
  stream.end('<!doctype html><title>H2</title>');
});
await new Promise((r) => h2Server.listen(0, '127.0.0.1', r));
const h2URL = `https://127.0.0.1:${h2Server.address().port}`;

// 4 servers that accept connections and never answer, 6 requests each (limit per host)
const hangServers = [];
let hangConnections = 0;
for (let i = 0; i < 4; i++) {
  const { server } = await serve(() => {});
  server.on('connection', () => hangConnections++);
  hangServers.push(server);
}
{
  const hangURLs = hangServers.flatMap((server) =>
    Array.from({ length: 6 }, (_, i) => `http://127.0.0.1:${server.address().port}/hangs/${i}`),
  );
  poolScript = `const HANG_URLS = ${JSON.stringify(hangURLs)};\nconst FREE_URL = ${JSON.stringify(`${siteURL}/free`)};\n`;
}

// ------------------------------------------------------- relay + host page + Chromium

const stack = await startStack({ token: 'e2e-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.addInitScript((pem) => {
  window.blTestOptions = { engine: { extraCA: pem } };
}, certs.ca);
const consoleLines = [];
page.on('console', (msg) => {
  consoleLines.push(msg.text());
  console.log('[chromium]', msg.text());
});
watchErrors(page, '[chromium error]');

const viewTitle = () => page.evaluate(() => window.blTest.view()?.title ?? '');
async function waitTitle(prefix, timeout = TIMEOUT) {
  const ok = await waitFor(async () => (await viewTitle()).startsWith(prefix), timeout, 500);
  if (!ok) console.log('Time limit, title is:', await viewTitle());
  return viewTitle();
}
const go = (address) => load(page, address);
const address = () => page.evaluate(() => window.blTest.view().url);

const started = Date.now();
check('host page starts the browser', await openHost(page, stack.app({ url: `${siteURL}/start` })));
const title = await waitTitle('E2E|');
console.log(`Title after ${((Date.now() - started) / 1000).toFixed(1)} s: ${title}`);

check('page loaded (redirect + script)', title.startsWith('E2E|'), title);
check('cookie set', title.includes('|bl=1|'));
check('fetch() with gzip', title.includes('|hello-gzip|'));
check('WebSocket (echo, umlauts)', title.includes('|ws:echo:ping-äöü|'));
check('WebSocketStream (echo)', /\|wsstream:echo:stream:(1000|1005)\|/.test(title), title);
check('HTTPS + WSS with an own CA (TLS in WASM)', title.includes('|tls-ok,wss:tls|'), title);
check('<video> is an HTMLMediaElement', title.includes('|media-ok'), title.split('|').pop());
check(
  'redirect through /start',
  requests.includes('/start') && requests.includes('/page'),
  requests.join(' '),
);

// A frame with the red box must be on the canvas
const redBox = async () => {
  const color = await pagePixel(page, 70, 70);
  return color && { r: color[0], g: color[1], b: color[2] };
};
const isRed = (pixel) => pixel && pixel.r > 200 && pixel.g < 40 && pixel.b < 40;
await page.waitForTimeout(1000);
const pixel = await redBox();
check('red box painted', isRed(pixel), JSON.stringify(pixel));

// GPU context lost (GPU reset): the engine keeps painting on the CPU
await page.evaluate(() => window.blTest.browser.debug.gpu('lose'));
await page.waitForTimeout(1500);
const pixelAfterLoss = await redBox();
check(
  'painting continues after GPU loss',
  isRed(pixelAfterLoss) && consoleLines.some((line) => line.includes('GPU: WebGL context lost')),
  JSON.stringify(pixelAfterLoss),
);

// The browser restores the context: the engine paints on the GPU again
await page.evaluate(() => window.blTest.browser.debug.gpu('restore'));
const gpuBack = await waitFor(
  () => consoleLines.some((line) => line.includes('GPU: WebGL context is back')),
  10000,
);
await page.evaluate(() =>
  window.blTest.eval('document.getElementById("box").style.background = "rgb(0, 0, 230)"'),
);
let pixelAfterRestore = null;
const isBlue = (pixel) => pixel && pixel.b > 200 && pixel.r < 40 && pixel.g < 40;
await waitFor(async () => isBlue((pixelAfterRestore = await redBox())), 10000);
check(
  'GPU restored, a change afterwards is painted',
  gpuBack && isBlue(pixelAfterRestore),
  JSON.stringify(pixelAfterRestore),
);
await page.evaluate(() =>
  window.blTest.eval('document.getElementById("box").style.background = ""'),
);

// Favicon: the engine loads it itself and hands it to the host (icon event)
const icon = await waitEvent(page, /^icon-image:/, 20000);
check(
  'favicon (icon event with an image)',
  icon === 'icon-image:16x16' && requests.includes('/icon.svg'),
  String(icon),
);
await screenshot(page, 'network');

// Safari 26 on the network (#283): its HTTP/2 SETTINGS, pseudo-header and header order, Priority
// and Accept-Encoding, Accept-Language with qualities
await go(`${h2URL}/fingerprint`);
await waitTitle('H2', 60000);
const h2Names = h2.headers.filter((_, i) => i % 2 === 0);
const h2Value = (name) => h2.headers[h2.headers.indexOf(name) + 1];
check(
  'HTTP/2 SETTINGS like Safari',
  h2.settings?.enablePush === false &&
    h2.settings.maxConcurrentStreams === 100 &&
    h2.settings.initialWindowSize === 2097152,
  JSON.stringify(h2.settings),
);
check(
  'navigation headers in Safari order',
  h2Names.join(',') ===
    ':method,:scheme,:authority,:path,sec-fetch-dest,user-agent,accept,sec-fetch-site,sec-fetch-mode,accept-language,priority,accept-encoding',
  h2Names.join(','),
);
check(
  'Priority, Accept-Encoding and Accept-Language like Safari',
  h2Value('priority') === 'u=0, i' &&
    h2Value('accept-encoding') === 'gzip, deflate, br, zstd' &&
    /^[a-zA-Z-]+(,[a-zA-Z-]+;q=0\.[1-9])*$/.test(h2Value('accept-language') ?? ''),
  `${h2Value('priority')} / ${h2Value('accept-encoding')} / ${h2Value('accept-language')}`,
);
h2Server.close();

// ------------------------------------------------------------- failures

await go(`${siteURL}/negative`);
const negative = await waitTitle('NEG|', 120000);
const outcome = Object.fromEntries(
  negative
    .replace(/^NEG\|/, '')
    .split('|')
    .map((part) => part.split('=')),
);
console.log('Failures:', JSON.stringify(outcome));
check(
  'counter check: good certificate in the same run',
  outcome.good === 'ok:tls-ok',
  outcome.good,
);
check('self-signed certificate rejected', outcome.self === 'refused:TypeError', outcome.self);
check('certificate for another name rejected', outcome.name === 'refused:TypeError', outcome.name);
if (certs.expired)
  check('expired certificate rejected', outcome.expired === 'refused:TypeError', outcome.expired);
check(
  'WSS with a self-signed certificate rejected',
  outcome['wss-self'] === 'refused',
  outcome['wss-self'],
);
check('connection refused (port closed)', outcome.refused === 'refused:TypeError', outcome.refused);
check('unknown name (DNS)', outcome.dns === 'refused:TypeError', outcome.dns);
check(
  'servers with a bad certificate get no request',
  !requests.some((r) => /^(self|name|expired):/.test(r)),
  requests.join(' '),
);

// Many hanging connections: another request still goes through
await go(`${siteURL}/pool`);
const pool = await waitTitle('POOL|', 60000);
check(
  '24 hanging connections, another request goes through',
  pool.startsWith('POOL|ok') && hangConnections >= 24,
  `${pool} (${hangConnections} connections)`,
);
for (const server of hangServers) server.closeAllConnections?.();

// A failing navigation: error page in the view with reason and code (like Chrome)
async function errorPage(code, ms = 60000) {
  let shown = null;
  for (const end = Date.now() + ms; Date.now() < end && !shown; await page.waitForTimeout(300)) {
    const from = consoleLines.length;
    await page
      .evaluate(() =>
        window.blTest.eval(
          '"ERRORPAGE|" + [document.querySelector("h1")?.textContent, document.querySelector("main p")?.textContent, document.querySelector(".code")?.textContent].join("|")',
        ),
      )
      .catch(() => {});
    await page.waitForTimeout(200);
    const line = consoleLines.slice(from).find((l) => l.includes('ERRORPAGE|'));
    const [, title, text, shownCode] = line
      ? line.slice(line.indexOf('ERRORPAGE|')).split(' (painting')[0].split('|')
      : [];
    if (shownCode === code) shown = { title, text, code: shownCode };
  }
  return shown || {};
}

await go(closedURL);
const refused = await errorPage('ERR_CONNECTION_REFUSED');
check(
  'error page: connection refused',
  refused.title === "This site can't be reached" &&
    refused.text === '127.0.0.1 refused to connect.',
  JSON.stringify(refused),
);
check(
  'error page: the view keeps the address that failed',
  (await address()) === closedURL,
  await address(),
);
// "Reload" on the error page loads the address that failed
{
  const revived = http.createServer((req, res) =>
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>BACK|here</title>'),
  );
  await new Promise((resolve) =>
    revived.listen(Number(new URL(closedURL).port), '127.0.0.1', resolve),
  );
  await page.evaluate(() =>
    window.blTest.eval('document.querySelector("[data-bl-retry]").click()'),
  );
  const reloaded = await waitTitle('BACK|', 30000);
  check(
    'error page: reload loads the address',
    reloaded.startsWith('BACK|') && (await address()) === closedURL,
    reloaded,
  );
  revived.close();
  revived.closeAllConnections();
}

await go('http://nonexistent.invalid/');
const dns = await errorPage('ERR_NAME_NOT_RESOLVED');
check(
  'error page: name not found',
  dns.text === 'The server IP address of nonexistent.invalid could not be found.',
  JSON.stringify(dns),
);

await go(`${secureURLs.selfSigned}/`);
const certificate = await errorPage('NET::ERR_CERT_INVALID');
check(
  'error page: certificate invalid',
  certificate.title === 'Your connection is not private' &&
    certificate.text?.includes('is not valid'),
  JSON.stringify(certificate),
);
check(
  'error page: commit event with the kind certificate',
  !!(await waitEvent(page, 'commit:certificate', 5000)),
);

// Back: the address without a name again, with the error page again
await page.evaluate(() => window.blTest.view().back());
const backAgain = await errorPage('ERR_NAME_NOT_RESOLVED');
check(
  'error page: back to the address before',
  backAgain.code === 'ERR_NAME_NOT_RESOLVED' && (await address()) === 'http://nonexistent.invalid/',
  await address(),
);

// The relay fails and comes back: the next page loads over a new connection
const pageLoads = () => requests.filter((r) => r === '/page').length;
const loadsBefore = pageLoads();
await stack.restartRelay();
await go(`${siteURL}/page`);
const again = await waitTitle('E2E|', 60000);
check(
  'after a relay restart: the page loads from the server again',
  again.startsWith('E2E|') && again.includes('|hello-gzip|') && pageLoads() > loadsBefore,
  again,
);

// Preconnect (#247, #251): one TLS connection ahead, which the following load takes
{
  const server = https.createServer(certs.good, (req, res) =>
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>preconnected</title>'),
  );
  let connections = 0;
  server.on('secureConnection', () => connections++);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${server.address().port}/`;
  await page.evaluate((target) => window.blTest.preconnect(target), url);
  const opened = await waitFor(() => connections === 1, 10000);
  await load(page, url);
  const loaded = !!(await waitEvent(page, 'title:preconnected', 15000));
  check(
    'preconnect: the load takes the connection opened ahead',
    opened && loaded && connections === 1,
    `${connections} TLS connections, loaded ${loaded}`,
  );
  server.close();
}

// Relay gone: the page is offline (navigator.onLine, offline event), then the transport
// reconnects by itself and the page is online again
await page.evaluate(() =>
  window.blTest.eval(
    'for (const type of ["offline", "online"]) addEventListener(type, () => console.log("NET " + type + " " + navigator.onLine))',
  ),
);
await page.waitForTimeout(500);
await stack.restartRelay();
const wentOffline = await waitFor(
  () => consoleLines.some((line) => line.includes('NET offline false')),
  10000,
);
check('relay gone: offline event, navigator.onLine false', wentOffline);
const cameBack = await waitFor(
  () => consoleLines.some((line) => line.includes('NET online true')),
  20000,
);
check('relay back: online event, navigator.onLine true', cameBack);
check(
  'network events of the browser (false, then true)',
  !!(await waitEvent(page, 'network:false', 1000)) &&
    !!(await waitEvent(page, 'network:true', 1000)),
);

// Relay gone while navigating: error page "No connection", it reloads itself as soon as the
// relay is back
{
  await stack.stopRelay();
  const loadsBefore = pageLoads();
  await go(`${siteURL}/page`);
  const noRelay = await errorPage('ERR_PROXY_CONNECTION_FAILED', 30000);
  check(
    'error page: no connection to the relay',
    noRelay.title === 'No connection',
    JSON.stringify(noRelay),
  );
  await stack.restartRelay();
  const reloaded = await waitTitle('E2E|', 60000);
  check(
    'error page reloads as soon as the relay is back',
    reloaded.startsWith('E2E|') && pageLoads() > loadsBefore,
    reloaded,
  );
}

// A form (POST) while the relay is gone: the error page does not send it again by itself, only
// "Resend" does, and then as POST with the data
{
  await go(`${siteURL}/form`);
  await waitTitle('FORM|', 30000);
  await stack.stopRelay();
  await page.evaluate(() => window.blTest.eval('document.forms[0].submit()'));
  await errorPage('ERR_PROXY_CONNECTION_FAILED', 30000);
  const button = () =>
    page.evaluate(() =>
      window.blTest.eval(
        'console.log("BUTTON|" + document.querySelector("[data-bl-retry]")?.textContent)',
      ),
    );
  const from = consoleLines.length;
  await button();
  await page.waitForTimeout(300);
  check(
    'error page after POST: button "Resend"',
    consoleLines.slice(from).some((line) => line.includes('BUTTON|Resend')),
    consoleLines.slice(from).join(' | '),
  );
  await stack.restartRelay();
  await page.waitForTimeout(5000);
  check(
    'error page after POST: no reload by itself',
    !requests.includes('/sent'),
    requests.slice(-5).join(' '),
  );
  await page.evaluate(() =>
    window.blTest.eval('document.querySelector("[data-bl-retry]").click()'),
  );
  const sent = await waitTitle('SENT|', 30000);
  check(
    'error page after POST: resend sends POST with the data',
    sent.startsWith('SENT|POST|field=value'),
    sent,
  );
}

// Stand-in Wisp relay: answers every CONNECT right away with the reason for the name
{
  const REASONS = { 'timeout.test': 0x43, 'blocked.test': 0x48, 'unreachable.test': 0x4a };
  const standIn = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => standIn.on('listening', resolve));
  standIn.on('connection', (ws) => {
    ws.send(Uint8Array.of(0x03, 0, 0, 0, 0, 128, 0, 0, 0));
    ws.on('message', (data) => {
      const packet = new Uint8Array(data);
      if (packet[0] === 0x01)
        ws.send(
          Uint8Array.of(
            0x04,
            ...packet.subarray(1, 5),
            REASONS[Buffer.from(packet.subarray(8)).toString()] ?? 0x41,
          ),
        );
    });
  });
  await openHost(
    page,
    stack.app({ url: 'http://timeout.test/', relay: `ws://127.0.0.1:${standIn.address().port}/` }),
  );
  const timedOut = await errorPage('ERR_CONNECTION_TIMED_OUT');
  check(
    'error page: no answer',
    timedOut.text === 'timeout.test took too long to respond.',
    JSON.stringify(timedOut),
  );
  await go('http://blocked.test/');
  const denied = await errorPage('ERR_ACCESS_DENIED');
  check(
    'error page: the relay blocks the target',
    denied.text ===
      'blocked.test could not be reached through the network relay. It only connects to public addresses and web ports.',
    JSON.stringify(denied),
  );
  await go('http://unreachable.test/');
  const unreachable = await errorPage('ERR_ADDRESS_UNREACHABLE');
  check(
    'error page: address unreachable',
    unreachable.text === 'unreachable.test is unreachable.',
    JSON.stringify(unreachable),
  );
  standIn.close();
}

await browser.close();
finish();
