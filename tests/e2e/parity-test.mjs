// Messlatte gegen Chromium: laedt tests/engine/features.html einmal direkt im
// Host-Chromium und einmal im browser-lite und vergleicht, welche Funktionen da sind.
// Ausgabe: "x von y wie Chromium", die Liste der Unterschiede nach Bereich und ein
// Markdown-Bericht (PARITY_REPORT=datei). Fehler nur, wenn eine Funktion aus
// parity-baseline.txt fehlt (Rueckschritt). PARITY_UPDATE=1 schreibt die Liste neu.
//
//   cd tests/e2e && node parity-test.mjs [engine-ordner]
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const baselineFile = path.join(here, 'parity-baseline.txt');
const TOKEN = 'parity-token-0123456789abcdef';
const RELAY_PORT = 15811;
const UI_PORT = 15812;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, 2 * TIMEOUT + 60000).unref();

const PAGE = readFileSync(path.join(root, 'tests', 'engine', 'features.html'));
const site = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}

// Sammelt "FEATURE name=wert" aus der Konsole, bis "FEATURE fertig" kommt
async function collect(page, load) {
  const results = new Map();
  let done;
  const finished = new Promise((r) => { done = r; });
  page.on('console', (msg) => {
    if (process.env.PARITY_DEBUG)
      console.log('   ', msg.text().slice(0, 200));
    const match = /FEATURE ([\w:.-]+)=(\S+)/.exec(msg.text());
    if (!match)
      return;
    if (match[1] === 'fertig')
      done();
    else
      results.set(match[1], match[2] === '1');
  });
  await load();
  await Promise.race([finished, new Promise((r) => setTimeout(r, TIMEOUT))]);
  return results;
}

// Referenz: das volle Chromium (nicht die headless shell, der fehlen manche APIs)
let reference;
{
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium' });
  } catch (e) {
    browser = await chromium.launch();
  }
  const page = await browser.newPage();
  reference = await collect(page, () => page.goto(siteURL));
  await browser.close();
}

const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});
let ours;
{
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
  ours = await collect(page, () => page.goto(`http://localhost:${UI_PORT}/?${query}`));
  await browser.close();
}
relay.kill();
ui.kill();
site.close();

if (!reference.size || !ours.size) {
  console.log(`FAIL keine Ergebnisse (Chromium ${reference.size}, browser-lite ${ours.size})`);
  process.exit(1);
}

// Vergleich: zaehlt nur, was Chromium kann
const names = [...reference.keys()];
const chromiumHas = names.filter((n) => reference.get(n));
const same = chromiumHas.filter((n) => ours.get(n));
const missing = chromiumHas.filter((n) => !ours.get(n));
const extra = names.filter((n) => !reference.get(n) && ours.get(n));
const percent = (100 * same.length / chromiumHas.length).toFixed(1);
console.log(`PARITY ${same.length} von ${chromiumHas.length} Funktionen wie Chromium (${percent} %)`);

const byArea = new Map();
for (const name of missing) {
  const area = name.split(':')[0];
  byArea.set(area, [...(byArea.get(area) || []), name.slice(area.length + 1)]);
}
for (const [area, list] of byArea)
  console.log(`  fehlt ${area} (${list.length}): ${list.join(', ')}`);
if (extra.length)
  console.log(`  nur browser-lite: ${extra.join(', ')}`);

if (process.env.PARITY_REPORT) {
  const lines = [`### Messlatte gegen Chromium`, '', `**${same.length} von ${chromiumHas.length}** Funktionen wie Chromium (${percent} %)`, ''];
  for (const [area, list] of byArea)
    lines.push(`- fehlt \`${area}\`: ${list.join(', ')}`);
  writeFileSync(process.env.PARITY_REPORT, lines.join('\n') + '\n');
}

// Rueckschritte gegen die gespeicherte Liste
let failed = 0;
const present = names.filter((n) => ours.get(n)).sort();
if (process.env.PARITY_UPDATE || !existsSync(baselineFile)) {
  writeFileSync(baselineFile, '# Funktionen, die browser-lite schon kann (tests/e2e/parity-test.mjs, PARITY_UPDATE=1)\n' + present.join('\n') + '\n');
  console.log(`Liste neu geschrieben: ${present.length} Funktionen`);
} else {
  const baseline = readFileSync(baselineFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const name of baseline) {
    if (!ours.get(name)) {
      console.log(`FAIL Rueckschritt: ${name} ging schon einmal`);
      failed++;
    }
  }
  const added = present.filter((n) => !baseline.includes(n));
  if (added.length)
    console.log(`  neu dazu (PARITY_UPDATE=1 zum Speichern): ${added.join(', ')}`);
}
console.log(failed ? `${failed} Rueckschritt(e)` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
