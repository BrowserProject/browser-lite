// End-to-End Test fuer Drag & Drop (engine/src/WebView.cpp, DragClient in
// Clients.cpp, WebCore platform/wasm/DragWasm.cpp): HTML5-Ziehen in der Seite
// mit der Maus (dragstart, setData, drop, dragend) und Ablegen von Dateien
// und Text aus dem Host (Ereignisse auf dem Canvas der Oberflaeche).
//
//   cd tests/e2e && node dragdrop-test.mjs [engine-ordner]
import { SWIFTSHADER, TIMEOUT, canvasOrigin, check, collect, finish, launch, screenshot, serve, startStack, timeLimit } from './harness.mjs';

timeLimit();

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
let drags = 0;
src.addEventListener('dragstart', (e) => {
  events.length = 0;
  drags++;
  events.push('dragstart');
  e.dataTransfer.setData('text/plain', 'hallo');
  e.dataTransfer.setData('application/x-test', 'geheim');
  e.dataTransfer.effectAllowed = 'copyMove';
});
src.addEventListener('dragend', (e) => {
  events.push('dragend:' + e.dataTransfer.dropEffect);
  log('events' + drags, events.join('|'));
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

const { url: siteURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));

const stack = await startStack({ token: 'dragdrop-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, ms = 20000) => results.wait(key, ms);

await page.goto(stack.app({ url: siteURL }));
check('Seite geladen', await result('ready', TIMEOUT) === '1');
const box = await canvasOrigin(page);

// 1. Ziehen in der Seite mit der Maus
await page.mouse.move(box.x + 80, box.y + 50);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 80 + i * 26, box.y + 50 + i * 2);
  await page.waitForTimeout(60);
}
await page.mouse.up();
check('drop mit setData-Daten und eigenen Typen', await result('drop') === 'hallo;geheim;text/plain,application/x-test', results.get('drop'));
const events = await result('events1');
check('dragstart, dragenter, dragover (Typen, Daten geschuetzt), drop, dragend mit dropEffect',
  events === 'dragstart|dragenter|dragover:text/plain,application/x-test:leer|drop|dragend:move', events);

// Escape bricht das Ziehen ab: dragend mit "none", kein drop
const dropsBefore = results.get('drop');
results.delete('drop');
await page.mouse.move(box.x + 80, box.y + 50);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 80 + i * 26, box.y + 50 + i * 2);
  await page.waitForTimeout(60);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.mouse.up();
check('Escape bricht ab (dragend none, kein drop)', await result('events2') === 'dragstart|dragenter|dragend:none' && !results.has('drop'), results.get('events2'));
if (dropsBefore)
  results.set('drop', dropsBefore);

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
await screenshot(page, 'dragdrop');

// 5. Abgelegte Dateien liegen im Ordner des Tabs und gehen mit ihm weg (bl_remove_path)
const uploadFolders = () => page.evaluate(() => {
  try {
    return window.__blEngine().FS.readdir('/tmp/uploads').filter((name) => name !== '.' && name !== '..').join(',');
  } catch (e) {
    return 'fehler:' + e.message;
  }
});
const foldersBefore = await uploadFolders();
check('Dateien im Ordner des Tabs', /^\d+$/.test(foldersBefore), foldersBefore);
await page.click('#tab-list .tab.active .close');
let foldersAfter = foldersBefore;
for (let i = 0; i < 50 && foldersAfter === foldersBefore; i++) {
  await page.waitForTimeout(100);
  foldersAfter = await uploadFolders();
}
check('Tab zu: seine Dateien geloescht', foldersAfter === '', foldersAfter);

await browser.close();
finish();
