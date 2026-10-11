// End-to-End Test fuer dauerhaften Speicher: Cookie, localStorage und
// IndexedDB muessen ein Neuladen der ganzen Oberflaeche ueberleben
// (/data in der Engine liegt im IndexedDB des Host-Browsers).
//
//   cd tests/e2e && node storage-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'store-token-0123456789abcdef';
const RELAY_PORT = 15401;
const UI_PORT = 15402;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, 2 * TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

// Erster Besuch speichert, zweiter Besuch (nach Neuladen) liest
const PAGE = `<!doctype html><title>Speicher-Test</title><script>
(async () => {
  const cookie = document.cookie.includes('bl_store=ja') ? 'ja' : 'nein';
  const local = localStorage.getItem('bl') || 'leer';
  const db = await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('werte');
    open.onerror = () => resolve('fehler');
    open.onsuccess = () => {
      const get = open.result.transaction('werte').objectStore('werte').get('x');
      get.onsuccess = () => resolve(get.result || 'leer');
      get.onerror = () => resolve('fehler');
    };
  });
  console.log('RESULT read=' + [cookie, local, db].join(','));
  localStorage.setItem('bl', 'gespeichert');
  await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('werte', 'readwrite');
      tx.objectStore('werte').put('idb-wert', 'x');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    };
    open.onerror = resolve;
  });
  console.log('RESULT written=1');
})();
</script>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'bl_store=ja; Path=/; Max-Age=86400' }).end(PAGE);
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext();
const page = await context.newPage();

let results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
});
async function result(key) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
const appURL = `http://localhost:${UI_PORT}/?${query}`;

await page.goto(appURL);
const first = await result('read');
check('Erster Besuch ist leer', first === 'nein,leer,leer', String(first));
check('Daten geschrieben', (await result('written')) === '1');

// Warten bis /data gespeichert ist (alle 5 s), dann alles neu laden
await page.waitForTimeout(7000);
results = new Map();
await page.reload();
const second = await result('read');
check('Nach Neuladen noch da (Cookie, localStorage, IndexedDB)', second === 'ja,gespeichert,idb-wert', String(second));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
