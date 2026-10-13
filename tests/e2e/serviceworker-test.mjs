// End-to-End Test fuer Service Worker und SharedWorker (engine/src/ServiceWorkerWasm.cpp):
// registrieren, Kontrolle per clients.claim(), Fetch abfangen (eigene Antwort,
// Cache API, Blob, nicht behandelt -> Netz), postMessage hin und zurueck und
// eine Navigation, die der Worker beantwortet.
//
//   cd tests/e2e && node serviceworker-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'serviceworker-token-0123456789abcdef';
const RELAY_PORT = 15821;
const UI_PORT = 15822;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

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

const PAGE = `<!doctype html><title>SW-Test</title><body>Service Worker
<script>
const log = (text) => console.log('RESULT ' + text);
// SharedWorker: beide Objekte reden mit demselben Worker
if (typeof SharedWorker === 'undefined')
  log('shared=none');
else {
  const a = new SharedWorker('/shared.js');
  a.port.onmessage = (e) => {
    log('sharedA=' + e.data);
    const b = new SharedWorker('/shared.js');
    b.port.onmessage = (e) => log('sharedB=' + e.data);
    b.port.postMessage('b');
  };
  a.port.postMessage('a');
}
(async () => {
  if (!('serviceWorker' in navigator)) { log('sw=none'); return; }
  log('initialcontroller=' + !!navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('message', (e) => log('message=' + e.data));
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  log('registered=1');
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  log('controlled=1');
  log('fetch=' + await (await fetch('/hello')).text());
  log('cached=' + await (await fetch('/cached')).text());
  log('blob=' + await (await fetch('/blob')).text());
  log('network=' + await (await fetch('/network')).text());
  navigator.serviceWorker.controller.postMessage('ping');
})().catch((e) => log('error=' + e));
</script>`;

const SW = `
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('v1').then((c) => c.put('/cached', new Response('cache-ok'))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/hello')
    e.respondWith(new Response('from-sw'));
  else if (url.pathname === '/cached')
    e.respondWith(caches.match('/cached'));
  else if (url.pathname === '/blob')
    e.respondWith(new Response(new Blob(['blob-ok'])));
  else if (url.pathname === '/sw-page')
    e.respondWith(new Response('<title>Vom Worker</title><script>console.log("RESULT swpage=" + !!navigator.serviceWorker.controller)</script>', { headers: { 'Content-Type': 'text/html' } }));
});
self.addEventListener('message', (e) => e.source.postMessage('pong:' + e.data));
`;

const SHARED = `
let connections = 0;
onconnect = (e) => {
  connections++;
  const port = e.ports[0];
  port.onmessage = (m) => port.postMessage(m.data + ':' + connections);
};
`;

const site = http.createServer((req, res) => {
  if (req.url === '/shared.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SHARED);
  if (req.url === '/sw.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SW);
  if (req.url === '/network')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('net');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}
const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});
process.on('exit', () => {
  relay.kill();
  ui.kill();
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = new Map();
page.on('console', (msg) => {
  const text = msg.text();
  const match = /RESULT (\w+)=(\S*)/.exec(text);
  if (match)
    results.set(match[1], match[2]);
  if (process.env.E2E_VERBOSE)
    console.log('   ', text);
});
async function result(key, ms = TIMEOUT) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    if (results.has('error'))
      return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL, debug: '1' });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('navigator.serviceWorker vorhanden', await result('registered') === '1' || results.get('sw') !== 'none', results.get('error') || '');
check('Registriert (ready)', await result('registered') === '1', results.get('error') || '');
check('Am Anfang ohne Worker', results.get('initialcontroller') === 'false', results.get('initialcontroller'));
check('Seite wird kontrolliert (clients.claim)', await result('controlled', 30000) === '1');
check('Fetch vom Worker beantwortet', await result('fetch', 30000) === 'from-sw', results.get('fetch'));
check('Antwort aus der Cache API des Workers', await result('cached', 30000) === 'cache-ok', results.get('cached'));
check('Antwort mit Blob', await result('blob', 30000) === 'blob-ok', results.get('blob'));
check('Nicht behandelt geht ins Netz', await result('network', 30000) === 'net', results.get('network'));
check('postMessage hin und zurueck', await result('message', 30000) === 'pong:ping', results.get('message'));

check('SharedWorker antwortet', await result('sharedA', 30000) === 'a:1', results.get('sharedA') || results.get('shared'));
check('Zweites SharedWorker-Objekt nutzt denselben Worker', await result('sharedB', 30000) === 'b:2', results.get('sharedB'));

// Navigation, die der Worker beantwortet (die Seite gibt es auf dem Server nicht)
await page.evaluate(() => window.__blEval('location.href = "/sw-page"'));
check('Navigation vom Worker beantwortet und kontrolliert', await result('swpage', 30000) === 'true', results.get('swpage'));

// Neustart des Browsers: die Registrierung kommt von der Platte (/data), die
// Seite ist von Anfang an kontrolliert
await page.waitForTimeout(7000);
results.clear();
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('Nach Neustart: Seite gleich kontrolliert', await result('initialcontroller', 60000) === 'true', results.get('initialcontroller'));
check('Nach Neustart: Fetch vom Worker beantwortet', await result('fetch', 30000) === 'from-sw', results.get('fetch'));
check('Nach Neustart: Cache API des Workers noch da', await result('cached', 30000) === 'cache-ok', results.get('cached'));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
