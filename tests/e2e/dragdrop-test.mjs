// End-to-End Test fuer Drag & Drop (engine/src/WebView.cpp, DragClient in
// Clients.cpp, WebCore platform/wasm/DragWasm.cpp): HTML5-Ziehen in der Seite
// mit der Maus (dragstart, setData, drop, dragend) und Ablegen von Dateien
// und Text aus dem Host (Ereignisse auf dem Canvas der Oberflaeche).
//
//   cd tests/e2e && node dragdrop-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'dragdrop-token-0123456789abcdef';
const RELAY_PORT = 15831;
const UI_PORT = 15832;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 120000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 60000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

const PAGE = `<!doctype html><title>Drag-Test</title>
<style>
body { margin: 0; font: 16px sans-serif }
#src { position: absolute; left: 20px; top: 20px; width: 120px; height: 60px; background: #8cf }
#zone { position: absolute; left: 300px; top: 20px; width: 200px; height: 120px; background: #fc8 }
#files { position: absolute; left: 300px; top: 200px; width: 200px; height: 120px; background: #cf8 }
#text { position: absolute; left: 20px; top: 200px; width: 200px; height: 80px }
#upload { position: absolute; left: 20px; top: 400px; width: 250px; height: 40px }
</style>
<div id="src" draggable="true">Zieh mich</div>
<div id="zone">Ablage</div>
<div id="files">Dateien</div>
<textarea id="text"></textarea>
<input id="upload" type="file">
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
const src = document.getElementById('src');
const zone = document.getElementById('zone');
const files = document.getElementById('files');
const events = [];
src.addEventListener('dragstart', (e) => {
  events.push('dragstart');
  e.dataTransfer.setData('text/plain', 'hallo');
  e.dataTransfer.setData('application/x-test', 'geheim');
  e.dataTransfer.effectAllowed = 'copyMove';
});
src.addEventListener('dragend', (e) => {
  events.push('dragend:' + e.dataTransfer.dropEffect);
  log('events', events.join('|'));
});
let overSeen = false;
zone.addEventListener('dragenter', (e) => { e.preventDefault(); events.push('dragenter'); });
zone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!overSeen) {
    overSeen = true;
    events.push('dragover:' + e.dataTransfer.types.join(',') + ':' + (e.dataTransfer.getData('text/plain') || 'leer'));
  }
});
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  events.push('drop');
  log('drop', [e.dataTransfer.getData('text/plain'), e.dataTransfer.getData('application/x-test'), e.dataTransfer.types.join(',')].join(';'));
});
let filesOver = '';
files.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!filesOver)
    filesOver = e.dataTransfer.types.join(',') + ':' + e.dataTransfer.files.length;
});
files.addEventListener('drop', async (e) => {
  e.preventDefault();
  log('filesover', filesOver);
  const list = [...e.dataTransfer.files];
  const parts = [];
  for (const file of list)
    parts.push(file.name + ':' + file.type + ':' + await file.text());
  log('files', parts.join('|'));
});
document.getElementById('text').addEventListener('input', (e) => log('textdrop', e.target.value));
document.getElementById('upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  log('upload', e.target.files.length + ':' + (file ? file.name + ':' + await file.text() : ''));
});
log('ready', 1);
</script>`;

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
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
async function result(key, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('Seite geladen', await result('ready', TIMEOUT) === '1');
const box = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});

// 1. Ziehen in der Seite mit der Maus
await page.mouse.move(box.x + 80, box.y + 50);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 80 + i * 26, box.y + 50 + i * 2);
  await page.waitForTimeout(60);
}
await page.mouse.up();
check('drop mit setData-Daten und eigenen Typen', await result('drop') === 'hallo;geheim;text/plain,application/x-test', results.get('drop'));
const events = await result('events');
check('dragstart, dragenter, dragover (Typen, Daten geschuetzt), drop, dragend mit dropEffect',
  events === 'dragstart|dragenter|dragover:text/plain,application/x-test:leer|drop|dragend:move', events);

// 2. Datei aus dem Host ablegen (Ereignisse auf dem Canvas wie beim Ziehen aus dem Dateimanager)
const dropOnCanvas = (x, y, fill) => page.evaluate(([x, y, fill]) => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const dataTransfer = new DataTransfer();
  if (fill.file)
    dataTransfer.items.add(new File([fill.file.content], fill.file.name, { type: fill.file.type }));
  if (fill.text)
    dataTransfer.setData('text/plain', fill.text);
  const fire = (type, dx = 0) => canvas.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x + dx, clientY: y, dataTransfer }));
  fire('dragenter');
  fire('dragover', -5);
  fire('dragover');
  fire('drop');
}, [x, y, fill]);
await dropOnCanvas(box.x + 400, box.y + 260, { file: { name: 'gruss.txt', type: 'text/plain', content: 'Grüezi aus dem Host' } });
check('Datei aus dem Host: Inhalt und Name', await result('files') === 'gruss.txt:text/plain:Grüezi_aus_dem_Host', results.get('files'));
check('beim Ziehen: Typ Files, aber noch keine Datei (wie Chrome)', await result('filesover') === 'Files:0', results.get('filesover'));

// 3. Text aus dem Host in ein Textfeld ablegen
await dropOnCanvas(box.x + 100, box.y + 240, { text: 'Text vom Host' });
check('Text aus dem Host ins Textfeld', await result('textdrop') === 'Text_vom_Host', results.get('textdrop'));

// 4. Datei auf <input type=file> ablegen
await dropOnCanvas(box.x + 100, box.y + 420, { file: { name: 'formular.csv', type: 'text/csv', content: 'a;b' } });
check('Datei auf <input type=file>', await result('upload') === '1:formular.csv:a;b', results.get('upload'));

await page.screenshot({ path: path.join(root, 'build', 'e2e-dragdrop.png') });
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
