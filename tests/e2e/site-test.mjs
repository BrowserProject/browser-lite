// Laedt echte Seiten aus dem Internet im browser-lite (Chromium + lokales Relay)
// und speichert pro Seite einen Screenshot. Braucht Internet-Zugang.
//
//   node site-test.mjs [engine-ordner] https://example.com/ https://de.wikipedia.org/ ...
//
// Ergebnis pro Seite: Titel, Ladezeit, Fehler. Screenshots in build/sites/.
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let args = process.argv.slice(2);
let engineDir = path.join(root, 'build', 'webcore', 'bin');
if (args[0] && !args[0].includes('://'))
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
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

let failed = 0;
for (const site of sites) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Optional eigene CA (z.B. wenn ein TLS-Proxy dazwischen ist): SITE_EXTRA_CA=datei.pem
  if (extraCA)
    await page.addInitScript((pem) => { window.__blExtraCA = pem; }, extraCA);
  const log = [];
  page.on('console', (msg) => log.push(msg.text()));
  const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: site });
  const started = Date.now();
  await page.goto(`http://localhost:${UI_PORT}/?${query}`);
  let result = 'ok';
  try {
    // Fertig, wenn der Tab nicht mehr laedt (Reload-Knopf statt Stop) oder ein Fehler kommt
    await page.waitForFunction(() => {
      const status = document.getElementById('status')?.textContent || '';
      return status.startsWith('Fehler') || window.__blLoaded === true;
    }, null, { timeout: TIMEOUT, polling: 250 });
    const status = await page.evaluate(() => document.getElementById('status')?.textContent || '');
    if (status.startsWith('Fehler')) {
      result = status;
      failed++;
    }
  } catch {
    result = 'Zeitlimit';
    failed++;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await page.waitForTimeout(1500);
  const title = await page.evaluate(() => document.title);
  const file = path.join(outDir, new URL(site).hostname + '.png');
  await page.screenshot({ path: file });
  console.log(`${result === 'ok' ? 'ok  ' : 'FAIL'} ${site} (${seconds} s) Titel: "${title}" ${result === 'ok' ? '' : result}`);
  if (result !== 'ok' || process.env.SITE_LOG)
    console.log(log.slice(-30).map((l) => '    ' + l).join('\n'));
  await page.close();
}

await browser.close();
relay.kill();
ui.kill();
process.exit(failed ? 1 : 0);
