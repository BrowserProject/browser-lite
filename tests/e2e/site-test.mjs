// Laedt echte Seiten aus dem Internet im browser-lite (Chromium + lokales Relay)
// und speichert pro Seite einen Screenshot. Braucht Internet-Zugang.
//
//   node site-test.mjs [engine-ordner] https://example.com/ https://de.wikipedia.org/ ...
//
// Ergebnis pro Seite: Titel, Ladezeit, Fehler. Screenshots in build/sites/.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let args = process.argv.slice(2);
let engineDir = path.join(root, 'build', 'webcore', 'bin');
if (args[0] && !/^[a-z][a-z0-9+.-]*:/i.test(args[0]))
  engineDir = path.resolve(args.shift());
const sites = args.length ? args : ['https://example.com/'];
const TOKEN = 'site-token-0123456789abcdef';
const RELAY_PORT = 15201;
const UI_PORT = 15202;
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 120000);
const extraCA = process.env.SITE_EXTRA_CA ? readFileSync(process.env.SITE_EXTRA_CA, 'utf8') : null;
const outDir = path.join(root, 'build', 'sites');
mkdirSync(outDir, { recursive: true });

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}

// Echtes Relay wie auf dem Server (ohne RELAY_ALLOW_LOCAL)
const relay = await start(path.join(root, 'relay', 'server.mjs'), [], { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});
// SwiftShader, damit WebGL der Seiten auch ohne GPU (headless, CI) geht
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.SITE_CHROME_ARGS ? process.env.SITE_CHROME_ARGS.split(' ') : [])] });
let browser = await launch();
// Promise mit Zeitlimit (page.evaluate hat keins und haengt, wenn die Seite blockiert)
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);

let failed = 0;
const rows = [];

async function checkSite(site, page, log) {
  // Optional eigene CA (z.B. wenn ein TLS-Proxy dazwischen ist): SITE_EXTRA_CA=datei.pem
  if (extraCA)
    await page.addInitScript((pem) => { window.__blExtraCA = pem; }, extraCA);
  page.on('console', (msg) => log.push(msg.text()));
  const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: site });
  // SITE_DEBUG=1: Ablauf der Engine mitschreiben (wird nur bei Problemen ausgegeben)
  if (process.env.SITE_DEBUG)
    query.set('debug', '1');
  // SITE_ENV=NAME=wert,...: Umgebungsvariablen der Engine (zum Vergleichen von Schaltern)
  if (process.env.SITE_ENV)
    query.set('env', process.env.SITE_ENV);
  const started = Date.now();
  await page.goto(`http://localhost:${UI_PORT}/?${query}`);
  let result = 'ok';
  try {
    // Fertig, wenn der Tab nicht mehr laedt (Reload-Knopf statt Stop) oder ein Fehler kommt
    await page.waitForFunction(() => {
      const status = document.getElementById('status')?.textContent || '';
      return status.startsWith('Fehler') || window.__blLoaded === true;
    }, null, { timeout: TIMEOUT, polling: 250 });
    const status = await within(page.evaluate(() => document.getElementById('status')?.textContent || ''), 10000, 'Status');
    if (status.startsWith('Fehler'))
      result = status;
  } catch {
    result = 'Zeitlimit';
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await page.waitForTimeout(Number(process.env.SITE_WAIT || 1500));
  let title = await within(page.evaluate(() => document.title), 10000, 'Titel');
  // Noch kein Titel: oft eine Bot-Pruefung (z.B. AWS WAF), die rechnet und dann
  // die echte Seite neu laedt. Darauf noch etwas warten.
  if (!title || /^Neuer Tab/.test(title)) {
    await page.waitForFunction(() => document.title && !/^Neuer Tab/.test(document.title), null, { timeout: 30000, polling: 500 }).catch(() => {});
    title = await within(page.evaluate(() => document.title), 10000, 'Titel');
  }
  const file = path.join(outDir, (new URL(site).hostname || 'seite') + '.png');
  await page.screenshot({ path: file, timeout: 20000 });
  return { result, seconds, title };
}

const printLog = (log, all) => console.log((all ? log : [...log.slice(0, 40), '...', ...log.slice(-20)]).map((l) => '    ' + l).join('\n'));

// Bei einem Haenger: wo steht der UI-Thread? (Stack ueber das Debugger-Protokoll)
async function mainThreadStack(cdp) {
  try {
    const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
    await within(cdp.send('Debugger.pause'), 10000, 'pause');
    const event = await within(paused, 10000, 'paused');
    return event.callFrames.slice(0, 30).map((frame) => `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${frame.location.lineNumber}`);
  } catch (e) {
    return ['(kein Stack: ' + e.message + ')'];
  }
}

for (const site of sites) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable').catch(() => {});
  const log = [];
  let outcome;
  try {
    // Harte Grenze pro Seite: eine blockierte Seite darf nicht den ganzen Lauf aufhalten
    outcome = await within(checkSite(site, page, log), TIMEOUT + 90000, 'Seite haengt');
  } catch (e) {
    outcome = { result: 'haengt (' + e.message + ')', seconds: '-', title: '' };
    log.push('Stack des UI-Threads:', ...await mainThreadStack(cdp));
  }
  const { result, seconds, title } = outcome;
  if (result !== 'ok')
    failed++;
  console.log(`${result === 'ok' ? 'ok  ' : 'FAIL'} ${site} (${seconds} s) Titel: "${title}" ${result === 'ok' ? '' : result}`);
  rows.push(`| ${site} | ${result === 'ok' ? 'geladen' : 'Fehler'} | ${seconds} s | ${title.replace(/ - browser-lite$/, '').replace(/\|/g, '/').slice(0, 60)} |`);
  // Leere Seite (kein Titel) oder Fehler: Log zeigen, damit man sieht, was passiert ist
  const blank = !title || /^Neuer Tab/.test(title);
  if (result !== 'ok' || blank || process.env.SITE_LOG)
    printLog(process.env.SITE_LOG === 'all' || result !== 'ok' ? log.slice(-80) : log, process.env.SITE_LOG === 'all' || result !== 'ok');
  try {
    await within(page.close(), 10000, 'close');
  } catch {
    // Seite reagiert nicht mehr: neuer Browser fuer den Rest
    await within(browser.close(), 10000, 'browser.close').catch(() => {});
    browser = await launch();
  }
}

// Kompatibilitaetsliste fuer die GitHub-Zusammenfassung
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Kompatibilitaet (echte Seiten)', '', '| Seite | Status | Zeit | Titel |', '|---|---|---|---|', ...rows, ''].join('\n') + '\n');
}

await browser.close();
relay.kill();
ui.kill();
process.exit(failed ? 1 : 0);
