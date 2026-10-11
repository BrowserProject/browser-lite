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
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
<html><head><title>laedt</title>
<style>body{margin:0;background:#fff} #box{position:absolute;left:20px;top:20px;width:100px;height:100px;background:#e00000}</style>
</head><body><div id="box"></div><p style="margin-top:140px">Netzwerk-Test</p>
<script src="/script.js"></script></body></html>`;

const SCRIPT = `
fetch('/data.txt').then((r) => r.text()).then((text) => {
  document.title = 'E2E|' + document.cookie + '|' + text.trim();
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
  case '/script.js':
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SCRIPT);
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
await new Promise((r) => site.listen(0, '127.0.0.1', r));
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
check('fetch() mit gzip', title.includes('|hallo-gzip'));
check('Redirect ueber /start', requests.includes('/start') && requests.includes('/page'), requests.join(' '));

// Ein Frame mit der roten Box sollte auf dem Canvas sein
await page.waitForTimeout(1000);
const pixel = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  if (!canvas)
    return null;
  const ratio = canvas.width / canvas.getBoundingClientRect().width;
  const [r, g, b] = canvas.getContext('2d').getImageData(Math.round(70 * ratio), Math.round(70 * ratio), 1, 1).data;
  return { r, g, b };
});
check('rote Box gemalt', pixel && pixel.r > 200 && pixel.g < 40 && pixel.b < 40, JSON.stringify(pixel));

await page.screenshot({ path: path.join(root, 'build', 'e2e-network.png') }).catch(() => {});
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
