// End-to-End Test: die ganze Kette im echten Chromium.
//
//   Oberflaeche (web/) -> Engine (WASM) -> curl -> SOCKFS -> Wisp -> Relay -> Testserver
//
// Der Testserver liefert eine Seite ueber einen Redirect aus, setzt ein Cookie,
// laedt ein Skript nach und eine gzip-Antwort per fetch(). Das Skript schreibt
// alles in den Titel, den wir in der Oberflaeche wieder auslesen.
// Danach die Fehlerfaelle: falsche Zertifikate (selbst signiert, falscher Name,
// abgelaufen), Verbindung abgelehnt, unbekannter Name, eine Navigation, die
// scheitert, und ein Relay, das waehrend der Sitzung neu startet.
//
//   cd tests/e2e && npm ci && node network-test.mjs [engine-ordner]
//
// Standard fuer den Engine-Ordner ist build/webcore/bin.
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { TIMEOUT, check, finish, freePort, launch, root, screenshot, serve, startStack, timeLimit } from './harness.mjs';

timeLimit(TIMEOUT + 240000);

// ------------------------------------------------------------ Testserver

const PAGE = `<!doctype html>
<html><head><title>laedt</title><link rel="icon" href="/icon.svg">
<style>body{margin:0;background:#fff} #box{position:absolute;left:20px;top:20px;width:100px;height:100px;background:#e00000}</style>
</head><body><div id="box"></div><p style="margin-top:140px">Netzwerk-Test</p>
<script src="/script.js"></script></body></html>`;

const SCRIPT = `
function webSocketEcho() {
  return new Promise((resolve) => {
    const socket = new WebSocket('ws://' + location.host + '/echo');
    const timer = setTimeout(() => resolve('ws-zeitlimit'), 20000);
    socket.onopen = () => socket.send('ping-äöü');
    socket.onmessage = (event) => { clearTimeout(timer); resolve('ws:' + event.data); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); resolve('ws-fehler'); };
  });
}
async function webSocketStreamEcho() {
  if (typeof WebSocketStream !== 'function')
    return 'wss-fehlt';
  try {
    const stream = new WebSocketStream('ws://' + location.host + '/echo');
    const { readable, writable } = await stream.opened;
    const writer = writable.getWriter();
    await writer.write('strom');
    const { value } = await readable.getReader().read();
    stream.close();
    const closed = await stream.closed;
    return 'wsstream:' + value + ':' + closed.closeCode;
  } catch (e) {
    return 'wsstream-fehler:' + e.name;
  }
}
function secure() {
  // HTTPS und WSS gegen den lokalen TLS-Server (Test-CA ueber window.__blExtraCA)
  return fetch(SECURE.good + '/secure.txt').then((r) => r.text()).then((text) => new Promise((resolve) => {
    const socket = new WebSocket(SECURE.good.replace('https', 'wss') + '/echo');
    const timer = setTimeout(() => resolve(text.trim() + ',wss-zeitlimit'), 20000);
    socket.onopen = () => socket.send('tls');
    socket.onmessage = (event) => { clearTimeout(timer); resolve(text.trim() + ',' + event.data); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); resolve(text.trim() + ',wss-fehler'); };
  }), (e) => 'https-fehler');
}
fetch('/data.txt').then((r) => r.text()).then(async (text) => {
  const ws = await webSocketEcho();
  const wsStream = await webSocketStreamEcho();
  const tls = await secure();
  const video = document.createElement('video');
  const media = video instanceof HTMLMediaElement && typeof video.pause === 'function' ? 'media-ok' : 'media-fehlt';
  document.title = 'E2E|' + document.cookie + '|' + text.trim() + '|' + ws + '|' + tls + '|' + wsStream + '|' + media;
}, (e) => { document.title = 'E2E|fetch-fehler|' + e; });
`;

// Fehlerfaelle: jede Anfrage endet mit "ok:<text>" oder "abgelehnt:<Fehler>",
// nie mit dem Zeitlimit. Der gute TLS-Server ist die Gegenprobe im selben Lauf.
const NEGATIVE = `<!doctype html><title>laedt</title><body>Fehlerfaelle<script>
const attempt = (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  return fetch(url, { signal: controller.signal }).then((r) => r.text()).then((text) => 'ok:' + text.trim(),
    (e) => controller.signal.aborted ? 'zeitlimit' : 'abgelehnt:' + e.name).finally(() => clearTimeout(timer));
};
const socket = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const timer = setTimeout(() => resolve('zeitlimit'), 20000);
  ws.onopen = () => { clearTimeout(timer); resolve('offen'); ws.close(); };
  ws.onerror = () => { clearTimeout(timer); resolve('abgelehnt'); };
});
(async () => {
  const out = [];
  for (const [name, url] of NEGATIVE_URLS)
    out.push(name + '=' + await attempt(url));
  out.push('wss-selbst=' + await socket(SECURE.selfSigned.replace('https', 'wss') + '/echo'));
  document.title = 'NEG|' + out.join('|');
})();
</script>`;

const requests = [];
let secureURLs = null;
// Port ohne Server: die Verbindung wird abgewiesen (Port 1 sperrt WebKit schon vorher)
const closedURL = `http://127.0.0.1:${await freePort()}/`;
const { server: site, url: siteRoot } = await serve((req, res) => {
  requests.push(req.url);
  const secureScript = () => `const SECURE = ${JSON.stringify(secureURLs)};\n`;
  switch (req.url) {
  case '/start':
    res.writeHead(302, { Location: '/page' }).end();
    break;
  case '/page':
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'bl=1; Path=/' }).end(PAGE);
    break;
  case '/icon.svg':
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0a0"/></svg>');
    break;
  case '/script.js':
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(secureScript() + SCRIPT);
    break;
  case '/negativ': {
    const urls = [['gut', secureURLs.good + '/secure.txt'], ['selbst', secureURLs.selfSigned + '/'], ['name', secureURLs.wrongName + '/'],
      ...(secureURLs.expired ? [['abgelaufen', secureURLs.expired + '/']] : []),
      ['abgewiesen', closedURL], ['dns', 'http://nonexistent.invalid/']];
    const script = secureScript() + `const NEGATIVE_URLS = ${JSON.stringify(urls)};\n`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(NEGATIVE.replace('<script>', '<script>' + script));
    break;
  }
  case '/data.txt': {
    const gz = (req.headers['accept-encoding'] || '').includes('gzip');
    const body = Buffer.from('hallo-gzip\n');
    res.writeHead(200, { 'Content-Type': 'text/plain', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gz ? zlib.gzipSync(body) : body);
    break;
  }
  default:
    res.writeHead(404).end();
  }
});
const siteURL = siteRoot.slice(0, -1);
// WebSocket-Echo der Testseite (WebSockets der Gastseite gehen auch ueber Wisp)
const echo = new WebSocketServer({ noServer: true });
echo.on('connection', (socket) => socket.on('message', (data) => socket.send('echo:' + data.toString())));
site.on('upgrade', (req, socket, head) => {
  if (req.url === '/echo')
    echo.handleUpgrade(req, socket, head, (ws) => echo.emit('connection', ws, req));
  else
    socket.destroy();
});

// TLS-Server mit eigener Test-CA: prueft TLS in der Engine (OpenSSL im WASM),
// HTTPS und WSS. Die CA kommt ueber window.__blExtraCA in die Engine.
// Dazu Server mit Zertifikaten, die die Engine ablehnen muss.
const certDir = path.join(root, 'build', 'e2e-certs');
mkdirSync(certDir, { recursive: true });
const openssl = (...args) => execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=browser-lite Test-CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
// Von der Test-CA signiert, mit Namen (SAN) und Gueltigkeit in Tagen (negativ: schon abgelaufen)
function signed(name, san, days) {
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=browser-lite Test');
  writeFileSync(path.join(certDir, `${name}.cnf`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', String(days), '-extfile', `${name}.cnf`);
  return { key: readFileSync(path.join(certDir, `${name}.key`)), cert: readFileSync(path.join(certDir, `${name}.pem`)) };
}
const good = signed('server', 'IP:127.0.0.1', 2);
const wrongName = signed('wrong-name', 'DNS:localhost', 2);
let expired = null;
try {
  expired = signed('expired', 'IP:127.0.0.1', -1);
} catch {
  console.log('Hinweis: openssl kann kein abgelaufenes Zertifikat machen, Fall uebersprungen');
}
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.pem', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1');
const selfSigned = { key: readFileSync(path.join(certDir, 'self.key')), cert: readFileSync(path.join(certDir, 'self.pem')) };
const testCA = readFileSync(path.join(certDir, 'ca.pem'), 'utf8');

async function secureServer(credentials, label) {
  const server = https.createServer(credentials, (req, res) => {
    requests.push(`${label}:${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('tls-ok\n');
  });
  const secureEcho = new WebSocketServer({ server, path: '/echo' });
  secureEcho.on('connection', (socket) => socket.on('message', (data) => socket.send('wss:' + data.toString())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `https://127.0.0.1:${server.address().port}`;
}
secureURLs = {
  good: await secureServer(good, 'https'),
  selfSigned: await secureServer(selfSigned, 'selbst'),
  wrongName: await secureServer(wrongName, 'name'),
  expired: expired ? await secureServer(expired, 'abgelaufen') : null,
};

// ------------------------------------------------------- Relay + Oberflaeche

const stack = await startStack({ token: 'e2e-token-0123456789abcdef' });

// ------------------------------------------------------------- Chromium

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.addInitScript((pem) => { window.__blExtraCA = pem; }, testCA);
page.on('console', (msg) => console.log('[chromium]', msg.text()));
page.on('pageerror', (error) => console.log('[chromium fehler]', error.message));

async function waitTitle(prefix, timeout = TIMEOUT) {
  try {
    await page.waitForFunction((p) => document.title.startsWith(p), prefix, { timeout, polling: 500 });
  } catch {
    console.log('Zeitlimit, Titel ist:', await page.title(), '| Status:', await page.evaluate(() => document.getElementById('status')?.textContent));
  }
  return page.title();
}
async function go(address) {
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}

const started = Date.now();
await page.goto(stack.app({ url: `${siteURL}/start` }));
const title = await waitTitle('E2E|');
console.log(`Titel nach ${((Date.now() - started) / 1000).toFixed(1)} s: ${title}`);

check('Seite geladen (Redirect + Skript)', title.startsWith('E2E|'), title);
check('Cookie gesetzt', title.includes('|bl=1|'));
check('fetch() mit gzip', title.includes('|hallo-gzip|'));
check('WebSocket (Echo, Umlaute)', title.includes('|ws:echo:ping-äöü|'));
check('WebSocketStream (Echo)', /\|wsstream:echo:strom:(1000|1005)\|/.test(title), title);
check('HTTPS + WSS mit eigener CA (TLS im WASM)', title.includes('|tls-ok,wss:tls|'), title);
check('<video> als HTMLMediaElement', title.includes('|media-ok'), title.split('|').pop());
check('Redirect ueber /start', requests.includes('/start') && requests.includes('/page'), requests.join(' '));

// Ein Frame mit der roten Box sollte auf dem Canvas sein
const redBox = () => page.evaluate(() => {
  const color = window.blPagePixel(70, 70);
  return color && { r: color[0], g: color[1], b: color[2] };
});
const isRed = (pixel) => pixel && pixel.r > 200 && pixel.g < 40 && pixel.b < 40;
await page.waitForTimeout(1000);
const pixel = await redBox();
check('rote Box gemalt', isRed(pixel), JSON.stringify(pixel));

// GPU-Kontext verloren (GPU-Reset): die Engine malt auf der CPU weiter
await page.evaluate(() => window.__blEngine()._bl_gpu_lose_context_for_testing());
await page.waitForTimeout(1500);
const pixelAfterLoss = await redBox();
check('nach GPU-Verlust weiter gemalt', isRed(pixelAfterLoss), JSON.stringify(pixelAfterLoss));

// Favicon: die Engine laedt es selber und gibt es der Oberflaeche
const icon = await page.waitForFunction(() => {
  const img = document.querySelector('.tab.active .icon') || document.querySelector('.tab .icon');
  return img && !img.hidden && img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
}, null, { timeout: 20000 }).then((handle) => handle.jsonValue(), () => 0);
check('Favicon im Tab', icon > 0 && requests.includes('/icon.svg'), `(Breite ${icon})`);
await screenshot(page, 'network');

// ------------------------------------------------------------- Fehlerfaelle

await go(`${siteURL}/negativ`);
const negative = await waitTitle('NEG|', 120000);
const outcome = Object.fromEntries(negative.replace(/^NEG\|/, '').replace(/ - browser-lite$/, '').split('|').map((part) => part.split('=')));
console.log('Fehlerfaelle:', JSON.stringify(outcome));
check('Gegenprobe: gutes Zertifikat im selben Lauf', outcome.gut === 'ok:tls-ok', outcome.gut);
check('Selbst signiertes Zertifikat abgelehnt', outcome.selbst === 'abgelehnt:TypeError', outcome.selbst);
check('Zertifikat fuer einen anderen Namen abgelehnt', outcome.name === 'abgelehnt:TypeError', outcome.name);
if (expired)
  check('Abgelaufenes Zertifikat abgelehnt', outcome.abgelaufen === 'abgelehnt:TypeError', outcome.abgelaufen);
check('WSS mit selbst signiertem Zertifikat abgelehnt', outcome['wss-selbst'] === 'abgelehnt', outcome['wss-selbst']);
check('Verbindung abgewiesen (Port zu)', outcome.abgewiesen === 'abgelehnt:TypeError', outcome.abgewiesen);
check('Unbekannter Name (DNS)', outcome.dns === 'abgelehnt:TypeError', outcome.dns);
check('Server mit falschem Zertifikat bekommen keine Anfrage', !requests.some((r) => /^(selbst|name|abgelaufen):/.test(r)), requests.join(' '));

// Navigation, die scheitert: Meldung in der Statuszeile
await go(closedURL);
const status = await page.waitForFunction(() => document.getElementById('status')?.textContent.startsWith('Fehler'), null, { timeout: 60000 })
  .then(() => true, () => false);
check('Navigation ohne Server: Fehler in der Statuszeile', status, await page.evaluate(() => document.getElementById('status')?.textContent));

// Relay faellt aus und kommt wieder: die naechste Seite laedt ueber eine neue Verbindung
const pageLoads = () => requests.filter((r) => r === '/page').length;
const loadsBefore = pageLoads();
await stack.restartRelay();
await go(`${siteURL}/page`);
const again = await waitTitle('E2E|', 60000);
check('Nach Neustart des Relays: Seite laedt wieder vom Server', again.startsWith('E2E|') && again.includes('|hallo-gzip|') && pageLoads() > loadsBefore, again);

await browser.close();
finish();
