// End-to-End Test: die ganze Kette im echten Chromium.
//
//   Oberflaeche (web/) -> Engine (WASM) -> curl -> SOCKFS -> Wisp -> Relay -> Testserver
//
// Der Testserver liefert eine Seite ueber einen Redirect aus, setzt ein Cookie,
// laedt ein Skript nach und eine gzip-Antwort per fetch(). Das Skript schreibt
// alles in den Titel, den wir in der Oberflaeche wieder auslesen.
//
//   cd tests/e2e && npm ci && node network-test.mjs [engine-ordner]
//
// Standard fuer den Engine-Ordner ist build/webcore/bin.
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'e2e-token-0123456789abcdef';
const RELAY_PORT = 15101;
const UI_PORT = 15102;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

// Nie ewig haengen
setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

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
  return fetch(SECURE + '/secure.txt').then((r) => r.text()).then((text) => new Promise((resolve) => {
    const socket = new WebSocket(SECURE.replace('https', 'wss') + '/echo');
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
  // <video> muss ein echtes HTMLMediaElement sein (Abspielen geht noch nicht)
  const video = document.createElement('video');
  const media = video instanceof HTMLMediaElement && typeof video.pause === 'function' ? 'media-ok' : 'media-fehlt';
  document.title = 'E2E|' + document.cookie + '|' + text.trim() + '|' + ws + '|' + tls + '|' + wsStream + '|' + media;
}, (e) => { document.title = 'E2E|fetch-fehler|' + e; });
`;

const requests = [];
const site = http.createServer((req, res) => {
  requests.push(req.url);
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
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`const SECURE = 'https://127.0.0.1:${secureSite.address().port}';\n` + SCRIPT);
    break;
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
// WebSocket-Echo der Testseite (WebSockets der Gastseite gehen auch ueber Wisp)
const echo = new WebSocketServer({ noServer: true });
echo.on('connection', (socket) => socket.on('message', (data) => socket.send('echo:' + data.toString())));
site.on('upgrade', (req, socket, head) => {
  if (req.url === '/echo')
    echo.handleUpgrade(req, socket, head, (ws) => echo.emit('connection', ws, req));
  else
    socket.destroy();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));

// TLS-Server mit eigener Test-CA: prueft TLS in der Engine (OpenSSL im WASM),
// HTTPS und WSS. Die CA kommt ueber window.__blExtraCA in die Engine.
const certDir = path.join(root, 'build', 'e2e-certs');
mkdirSync(certDir, { recursive: true });
const openssl = (...args) => execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=browser-lite Test-CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1');
writeFileSync(path.join(certDir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'ext.cnf');
const testCA = readFileSync(path.join(certDir, 'ca.pem'), 'utf8');
const secureSite = https.createServer({ key: readFileSync(path.join(certDir, 'server.key')), cert: readFileSync(path.join(certDir, 'server.pem')) }, (req, res) => {
  requests.push('https:' + req.url);
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('tls-ok\n');
});
const secureEcho = new WebSocketServer({ server: secureSite, path: '/echo' });
secureEcho.on('connection', (socket) => socket.on('message', (data) => socket.send('wss:' + data.toString())));
await new Promise((r) => secureSite.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}`;

// ------------------------------------------------------- Relay + Oberflaeche

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    process.stdout.write(d);
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}

const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});

// ------------------------------------------------------------- Chromium

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.addInitScript((pem) => { window.__blExtraCA = pem; }, testCA);
page.on('console', (msg) => console.log('[chromium]', msg.text()));
page.on('pageerror', (error) => console.log('[chromium fehler]', error.message));

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: `${siteURL}/start` });
const started = Date.now();
await page.goto(`http://localhost:${UI_PORT}/?${query}`);

let title = '';
try {
  await page.waitForFunction(() => document.title.startsWith('E2E|'), null, { timeout: TIMEOUT, polling: 500 });
  title = await page.evaluate(() => document.title);
} catch {
  title = await page.evaluate(() => document.title);
  console.log('Zeitlimit, Titel ist:', title, '| Status:', await page.evaluate(() => document.getElementById('status')?.textContent));
}
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
await page.waitForTimeout(1000);
const pixel = await page.evaluate(() => {
  const color = window.blPagePixel(70, 70);
  return color && { r: color[0], g: color[1], b: color[2] };
});
check('rote Box gemalt', pixel && pixel.r > 200 && pixel.g < 40 && pixel.b < 40, JSON.stringify(pixel));

// GPU-Kontext verloren (GPU-Reset): die Engine malt auf der CPU weiter
await page.evaluate(() => window.__blEngine()._bl_gpu_lose_context_for_testing());
await page.waitForTimeout(1500);
const pixelAfterLoss = await page.evaluate(() => {
  const color = window.blPagePixel(70, 70);
  return color && { r: color[0], g: color[1], b: color[2] };
});
check('nach GPU-Verlust weiter gemalt', pixelAfterLoss && pixelAfterLoss.r > 200 && pixelAfterLoss.g < 40 && pixelAfterLoss.b < 40, JSON.stringify(pixelAfterLoss));

// Favicon: die Engine laedt es selber und gibt es der Oberflaeche
const icon = await page.waitForFunction(() => {
  const img = document.querySelector('.tab.active .icon') || document.querySelector('.tab .icon');
  return img && !img.hidden && img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
}, null, { timeout: 20000 }).then((handle) => handle.jsonValue(), () => 0);
check('Favicon im Tab', icon > 0 && requests.includes('/icon.svg'), `(Breite ${icon})`);

await page.screenshot({ path: path.join(root, 'build', 'e2e-network.png') }).catch(() => {});
await browser.close();
relay.kill();
ui.kill();
site.close();
secureSite.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
