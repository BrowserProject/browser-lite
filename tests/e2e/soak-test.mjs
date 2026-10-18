// Langer Lauf: viele Navigationen durch verschiedene Seiten (DOM mit Iframe,
// Bilder, Worker, WebAssembly, Audio) in einem Tab, dann Tabs oeffnen und
// schliessen. Danach (alles Freigebbare frei, voller GC) muessen die Dokumente
// wieder auf dem Stand nach dem Aufwaermen sein und malloc und der WASM-Speicher
// duerfen nur wenig gewachsen sein, sonst lebt etwas pro Seite weiter.
//
//   cd tests/e2e && node soak-test.mjs [engine-ordner]
//   SOAK_ROUNDS (Standard 40) Runden durch alle Seiten, SOAK_TABS (Standard 30)
import fs from 'node:fs';
import path from 'node:path';
import { TIMEOUT, VERBOSE, check, finish, here, launch, serve, serveBytes, startStack, timeLimit, watchErrors, wav } from './harness.mjs';

timeLimit(TIMEOUT + 420000);
const ROUNDS = Number(process.env.SOAK_ROUNDS || 40);
const TABS = Number(process.env.SOAK_TABS || 30);
const WARMUP = 2;

// Unkomprimiertes BMP (24 Bit), jedes Bild mit eigener Farbe
function bmp(size, seed) {
  const row = size * 3;
  const buffer = Buffer.alloc(54 + row * size);
  buffer.write('BM', 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(size, 18);
  buffer.writeInt32LE(size, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(row * size, 34);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++)
      buffer.set([(x * seed) & 255, (y * 3) & 255, (seed * 40) & 255], 54 + y * row + x * 3);
  }
  return buffer;
}
const IMAGES = [1, 2, 3, 4].map((seed) => bmp(512, seed));

const TONE = wav(5, { frequency: 0 });

const done = (name) => `const round = new URLSearchParams(location.search).get('r'); console.log('RESULT done=${name}-' + round)`;
const PAGES = {
  leer: `<!doctype html><title>leer</title><p>leer<script>${done('leer')}</script>`,
  dom: `<!doctype html><title>dom</title><style>.c{display:inline-block;padding:2px;margin:1px;border:1px solid #ccc;border-radius:3px}</style>
<div id="list"></div><iframe srcdoc="<p>im Iframe</p><script>parent.postMessage('frame', '*')</script>"></iframe>
<script>const list = document.getElementById('list');
for (let i = 0; i < 3000; i++) { const div = document.createElement('div'); div.className = 'c'; div.textContent = 'Element ' + i; div.onclick = () => div.remove(); list.append(div); }
const objects = []; for (let i = 0; i < 20000; i++) objects.push({ i, text: 'x' + i, next: objects[i - 1] });
window.keep = objects;
addEventListener('message', () => { document.body.offsetHeight; ${done('dom')} });</script>`,
  bilder: `<!doctype html><title>bilder</title>${[0, 1, 2, 3].map((i) => `<img src="/bild${i}.bmp" width="256" height="256">`).join('')}
<script>Promise.all([...document.images].map((img) => img.decode())).then(() => { ${done('bilder')} }, (e) => console.log('RESULT done=fehler-' + e))</script>`,
  worker: `<!doctype html><title>worker</title><script>
const source = 'onmessage = (e) => { let sum = 0; const data = new Float64Array(e.data); for (let i = 0; i < data.length; i++) sum += i; postMessage(sum); }';
const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
worker.onmessage = (e) => { if (e.data === 1048575 * 1048576 / 2) { ${done('worker')} } };
worker.postMessage(1 << 20);</script>`,
  wasm: `<!doctype html><title>wasm</title><script>
fetch('/small.wasm').then((r) => r.arrayBuffer()).then((bytes) => WebAssembly.instantiate(bytes, {})).then(({ instance }) => {
  instance.exports.grow(4);
  if (typeof instance.exports.sum() === 'number') { ${done('wasm')} }
});</script>`,
  audio: `<!doctype html><title>audio</title><audio src="/ton.wav" preload="auto"></audio><script>
document.querySelector('audio').addEventListener('loadedmetadata', () => { ${done('audio')} });</script>`,
};
const SEQUENCE = ['dom', 'bilder', 'worker', 'wasm', 'audio'];

const smallWasm = fs.readFileSync(path.join(here, 'fixtures', 'small.wasm'));
const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (PAGES[name])
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[name]);
  const image = /^bild(\d)\.bmp$/.exec(name);
  if (image)
    return res.writeHead(200, { 'Content-Type': 'image/bmp', 'Cache-Control': 'max-age=3600' }).end(IMAGES[image[1]]);
  if (name === 'small.wasm')
    return res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(smallWasm);
  if (name === 'ton.wav')
    return serveBytes(req, res, TONE, 'audio/wav');
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'soak-token-0123456789abcdef' });
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
watchErrors(page);
const finished = new Set();
const reportLines = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (VERBOSE)
    console.log('   ', text);
  const match = /RESULT done=(\S+)/.exec(text);
  if (match)
    finished.add(match[1]);
  if (text.includes('[memory]'))
    reportLines.push(text);
});
async function waitDone(key, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (finished.has(key))
      return true;
  }
  return false;
}
async function go(address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}

// Alles Freigebbare frei, voller GC (bl_memory_report 3), dann der Bericht der Engine
async function measure() {
  await page.waitForTimeout(500);
  reportLines.length = 0;
  const line = page.waitForEvent('console', { predicate: (msg) => /malloc used \d+ MB/.test(msg.text()), timeout: 60000 });
  await page.evaluate(() => window.blTest.memory(3));
  const text = (await line).text();
  await page.waitForTimeout(500);
  return {
    malloc: Number(/malloc used (\d+) MB/.exec(text)[1]),
    documents: Number(/documents (\d+)/.exec(text)[1]),
    wasm: Math.round(await page.evaluate(() => window.blTest.memory()) / 2 ** 20),
    players: await page.evaluate(() => window.blTest.mediaState().length),
    documentList: reportLines.filter((l) => l.includes('doc refs=')),
  };
}

// Dokumente der letzten Seiten haelt noch laufende Arbeit (Ton dekodieren,
// WebAssembly kompilieren) kurz fest: messen, bis die Zahl nicht mehr sinkt
async function measureSettled() {
  let best = await measure();
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(2000);
    const next = await measure();
    if (next.documents >= best.documents)
      return best;
    best = next;
  }
  return best;
}

await page.goto(stack.app({ url: siteURL + 'leer?r=start' }));
check('Erste Seite', await waitDone('leer-start', TIMEOUT));

let navigations = 0;
let failedAt = null;
async function rounds(from, to) {
  for (let round = from; round < to && !failedAt; round++) {
    for (const name of SEQUENCE) {
      await go(`${siteURL}${name}?r=${round}`);
      navigations++;
      if (!await waitDone(`${name}-${round}`)) {
        failedAt = `${name}-${round}`;
        return;
      }
    }
  }
}

const started = Date.now();
await rounds(0, WARMUP);
await go(siteURL + 'leer?r=basis');
await waitDone('leer-basis');
const base = await measureSettled();
console.log(`     nach dem Aufwaermen: ${JSON.stringify({ ...base, documentList: base.documentList.length })}`);

await rounds(WARMUP, ROUNDS);
check(`${navigations} Navigationen durch ${SEQUENCE.join(', ')}`, !failedAt, failedAt ? `haengt bei ${failedAt}` : `${Math.round((Date.now() - started) / 1000)} s`);

// Tabs oeffnen (DOM-Seite mit Iframe laden) und wieder schliessen
let tabsOk = true;
for (let i = 0; i < TABS && tabsOk; i++) {
  await page.click('#new-tab');
  await go(`${siteURL}dom?r=tab${i}`);
  tabsOk = await waitDone(`dom-tab${i}`);
  await page.click('#tab-list .tab.active .close');
}
const tabCount = await page.locator('#tab-list .tab').count();
check(`${TABS} Tabs geoeffnet und geschlossen`, tabsOk && tabCount === 1, `${tabCount} Tabs offen`);

await go(siteURL + 'leer?r=ende');
await waitDone('leer-ende');
const end = await measureSettled();
console.log(`     am Ende: ${JSON.stringify({ ...end, documentList: end.documentList.length })}`);
const leaked = end.documents > base.documents + 2;
check('Dokumente wieder wie nach dem Aufwaermen', !leaked, `${base.documents} -> ${end.documents}`);
if (leaked)
  console.log(end.documentList.join('\n'));
check('malloc belegt kaum mehr', end.malloc - base.malloc < 48, `${base.malloc} -> ${end.malloc} MB`);
check('WASM-Speicher waechst kaum', end.wasm - base.wasm < 128, `${base.wasm} -> ${end.wasm} MB`);
check('Keine Player der Oberflaeche uebrig', end.players === 0, `${end.players} Player`);

await browser.close();
finish();
