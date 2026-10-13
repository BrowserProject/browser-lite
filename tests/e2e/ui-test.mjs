// End-to-End Test fuer die Oberflaeche (web/library.js): Verlauf, Lesezeichen,
// Vorschlaege in der Adressleiste, Suchmaschine, Sitzung wiederherstellen
// (Hintergrund-Tabs laden erst beim Anklicken).
//
//   cd tests/e2e && node ui-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'ui-token-0123456789abcdef';
const RELAY_PORT = 15831;
const UI_PORT = 15832;
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

const loads = new Map();
const page = (title) => title === 'Seite links'
  ? `<!doctype html><title>${title}</title><body style="margin:0"><a id="l" href="/ziel" style="display:block;width:300px;height:60px;background:#9cf">Link</a><script>console.log('RESULT loaded=' + document.title)</script>`
  : `<!doctype html><title>${title}</title><h1>${title}</h1><script>console.log('RESULT loaded=' + document.title)</script>`;
const site = http.createServer((req, res) => {
  const name = req.url.slice(1) || 'start';
  loads.set(name, (loads.get(name) || 0) + 1);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Seite ' + name));
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
const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const tab = await context.newPage();
let loaded = [];
tab.on('console', (msg) => {
  if (process.env.E2E_LOG)
    console.log('[chromium]', msg.text());
  const match = /RESULT loaded=(.*?)(\s+\(|$)/.exec(msg.text());
  if (match)
    loaded.push(match[1]);
});
async function waitLoaded(title, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (loaded.includes(title))
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function go(address) {
  await tab.click('#address');
  await tab.fill('#address', address);
  await tab.press('#address', 'Enter');
}

const base = { relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN };
await tab.goto(`http://localhost:${UI_PORT}/?${new URLSearchParams({ ...base, url: siteURL + 'eins' })}`);
check('Erste Seite', await waitLoaded('Seite eins', TIMEOUT));
await go(siteURL + 'zwei');
check('Zweite Seite ueber die Adressleiste', await waitLoaded('Seite zwei'));

// Verlauf (Strg+H): beide Seiten, neueste zuerst
await tab.keyboard.press('Control+h');
const history = await tab.locator('#side-panel .panel-title').allTextContents();
check('Verlauf', history[0] === 'Seite zwei' && history.includes('Seite eins'), JSON.stringify(history.slice(0, 3)));
await tab.keyboard.press('Escape');
check('Panel mit Esc zu', await tab.evaluate(() => document.getElementById('side-panel').hidden));

// Lesezeichen (Stern), Panel Strg+Umschalt+O
await tab.click('#bookmark');
check('Stern aktiv', await tab.evaluate(() => document.getElementById('bookmark').classList.contains('active')));
await tab.keyboard.press('Control+Shift+O');
const bookmarks = await tab.locator('#side-panel .panel-title').allTextContents();
check('Lesezeichen im Panel', bookmarks.length === 1 && bookmarks[0] === 'Seite zwei', JSON.stringify(bookmarks));
await tab.keyboard.press('Escape');

// Vorschlaege: "eins" tippen findet die erste Seite aus dem Verlauf
await tab.click('#address');
await tab.fill('#address', '');
await tab.type('#address', 'eins');
const suggestion = await tab.locator('#suggestions:not([hidden]) .suggestion-url').first().textContent({ timeout: 5000 }).catch(() => null);
check('Vorschlag aus dem Verlauf', suggestion === siteURL + 'eins', String(suggestion));
loaded = [];
await tab.keyboard.press('ArrowDown');
await tab.keyboard.press('Enter');
check('Vorschlag oeffnen', await waitLoaded('Seite eins'));

// Suchmaschine in den Einstellungen: Text ohne Punkt wird eine Suche
await tab.click('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Einstellungen' }).click();
await tab.selectOption('#setting-search', 'google');
const searchURL = await tab.evaluate(async () => (await import('./library.js')).addressToURL('wetter bern'));
check('Suchmaschine', searchURL === 'https://www.google.com/search?q=wetter%20bern', searchURL);
await tab.keyboard.press('Escape');

// Sitzung: zweiter Tab, dann die Oberflaeche ohne ?url= neu oeffnen
await tab.click('#new-tab');
await go(siteURL + 'drei');
check('Dritte Seite im neuen Tab', await waitLoaded('Seite drei'));
await tab.waitForTimeout(500);
const loadsBefore = loads.get('eins') || 0;
loaded = [];
await tab.goto(`http://localhost:${UI_PORT}/?${new URLSearchParams(base)}`);
check('Sitzung: aktiver Tab laedt wieder', await waitLoaded('Seite drei', TIMEOUT));
const titles = await tab.locator('#tab-list .tab .title').allTextContents();
check('Sitzung: beide Tabs da', titles.length === 2 && titles[0] === 'Seite eins' && titles[1] === 'Seite drei', JSON.stringify(titles));
await tab.waitForTimeout(1500);
check('Sitzung: Hintergrund-Tab laedt noch nicht', (loads.get('eins') || 0) === loadsBefore, `${loads.get('eins')} Aufrufe`);
await tab.click('#tab-list .tab:first-child .title');
check('Sitzung: Hintergrund-Tab laedt beim Anklicken', await waitLoaded('Seite eins'));

// Links: Strg+Klick und Mittelklick oeffnen je einen Tab im Hintergrund
await go(siteURL + 'links');
check('Seite mit Link', await waitLoaded('Seite links'));
const tabCount = () => tab.locator('#tab-list .tab').count();
const before = await tabCount();
const box = await tab.evaluate(() => {
  const rect = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none').getBoundingClientRect();
  return { x: rect.left + 100, y: rect.top + 30 };
});
await tab.keyboard.down('Control');
await tab.mouse.click(box.x, box.y);
await tab.keyboard.up('Control');
await tab.waitForTimeout(1500);
check('Strg+Klick: neuer Tab im Hintergrund', (await tabCount()) === before + 1 && (await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent)) === 'Seite links', `${await tabCount()} Tabs`);
await tab.mouse.click(box.x, box.y, { button: 'middle' });
await tab.waitForTimeout(1500);
check('Mittelklick: genau ein neuer Tab', (await tabCount()) === before + 2, `${await tabCount()} Tabs`);
check('Sicherheitsanzeige bei HTTP', await tab.evaluate(() => !document.getElementById('security').hidden && document.getElementById('security').textContent === 'Nicht sicher'));

// Quelltext (Strg+U): neuer Tab mit dem HTML der Seite
await tab.locator('#tab-list .tab.active .title').click();
await tab.keyboard.press('Control+u');
const sourceTab = await tab.waitForFunction(() => document.querySelector('#tab-list .tab.active .title')?.textContent?.startsWith('view-source:'), null, { timeout: 15000 }).then(() => true, () => false);
check('Quelltext anzeigen (Strg+U)', sourceTab, await tab.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
