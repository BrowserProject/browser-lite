// Drag and drop (engine/src/WebView.cpp, DragClient in Clients.cpp, WebCore
// platform/wasm/DragWasm.cpp): HTML5 dragging in the page with the mouse (dragstart, setData,
// drop, dragend) and dropping files and text from the host (events on the view canvas). Dropped
// files live in the folder of the view and go away with it.
//
//   node tests/core/dragdrop-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Drag test</title>
<style>
body { margin: 0; font: 16px sans-serif }
#src { position: absolute; left: 20px; top: 20px; width: 120px; height: 60px; background: #8cf }
#zone { position: absolute; left: 300px; top: 20px; width: 200px; height: 120px; background: #fc8 }
#files { position: absolute; left: 300px; top: 200px; width: 200px; height: 120px; background: #cf8 }
#text { position: absolute; left: 20px; top: 200px; width: 200px; height: 80px }
#upload { position: absolute; left: 20px; top: 400px; width: 250px; height: 40px }
</style>
<div id="src" draggable="true">Drag me</div>
<div id="zone">Drop zone</div>
<div id="files">Files</div>
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
  e.dataTransfer.setData('text/plain', 'hello');
  e.dataTransfer.setData('application/x-test', 'secret');
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
    events.push('dragover:' + e.dataTransfer.types.join(',') + ':' + (e.dataTransfer.getData('text/plain') || 'empty'));
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

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'dragdrop-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, ms = 20000) => results.wait(key, ms);

await openHost(page, stack.app({ url: siteURL }));
check('page loaded', (await result('ready', TIMEOUT)) === '1');
const box = await canvasOrigin(page);

// 1. Dragging in the page with the mouse
await page.mouse.move(box.x + 80, box.y + 50);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 80 + i * 26, box.y + 50 + i * 2);
  await page.waitForTimeout(60);
}
await page.mouse.up();
check(
  'drop with setData data and own types',
  (await result('drop')) === 'hello;secret;text/plain,application/x-test',
  results.get('drop'),
);
const events = await result('events1');
check(
  'dragstart, dragenter, dragover (types, data protected), drop, dragend with dropEffect',
  events === 'dragstart|dragenter|dragover:text/plain,application/x-test:empty|drop|dragend:move',
  events,
);

// Escape cancels dragging: dragend with "none", no drop
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
check(
  'Escape cancels (dragend none, no drop)',
  (await result('events2')) === 'dragstart|dragenter|dragend:none' && !results.has('drop'),
  results.get('events2'),
);
if (dropsBefore) results.set('drop', dropsBefore);

// 2. Drop a file from the host (events on the canvas like dragging from a file manager)
const dropOnCanvas = (x, y, fill) =>
  page.evaluate(
    ([x, y, fill]) => {
      const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
        (c) => c.style.display !== 'none',
      );
      const dataTransfer = new DataTransfer();
      if (fill.file)
        dataTransfer.items.add(
          new File([fill.file.content], fill.file.name, { type: fill.file.type }),
        );
      if (fill.text) dataTransfer.setData('text/plain', fill.text);
      const fire = (type, dx = 0) =>
        canvas.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x + dx,
            clientY: y,
            dataTransfer,
          }),
        );
      fire('dragenter');
      fire('dragover', -5);
      fire('dragover');
      fire('drop');
    },
    [x, y, fill],
  );
await dropOnCanvas(box.x + 400, box.y + 260, {
  file: { name: 'greeting.txt', type: 'text/plain', content: 'Grüezi from the host' },
});
check(
  'file from the host: content and name',
  (await result('files')) === 'greeting.txt:text/plain:Grüezi_from_the_host',
  results.get('files'),
);
check(
  'while dragging: type Files, but no file yet (like Chrome)',
  (await result('filesover')) === 'Files:0',
  results.get('filesover'),
);

// 3. Drop text from the host into a text field
await dropOnCanvas(box.x + 100, box.y + 240, { text: 'Text from the host' });
check(
  'text from the host into the text field',
  (await result('textdrop')) === 'Text_from_the_host',
  results.get('textdrop'),
);

// 4. Drop a file onto <input type=file>
await dropOnCanvas(box.x + 100, box.y + 420, {
  file: { name: 'form.csv', type: 'text/csv', content: 'a;b' },
});
check(
  'file onto <input type=file>',
  (await result('upload')) === '1:form.csv:a;b',
  results.get('upload'),
);
await screenshot(page, 'dragdrop');

// 5. Dropped files live in the folder of the view and go away with it (bl_remove_path)
const uploadFolders = () =>
  page.evaluate(() => {
    try {
      return window.blTest.browser.debug.module.FS.readdir('/data/tmp/uploads')
        .filter((name) => name !== '.' && name !== '..')
        .join(',');
    } catch (e) {
      return 'error:' + e.message;
    }
  });
const foldersBefore = await uploadFolders();
check('files in the folder of the view', /^\d+$/.test(foldersBefore), foldersBefore);
await page.evaluate(() => window.blTest.view().close({ force: true }));
let foldersAfter = foldersBefore;
for (let i = 0; i < 50 && foldersAfter === foldersBefore; i++) {
  await page.waitForTimeout(100);
  foldersAfter = await uploadFolders();
}
check('view closed: its files deleted', foldersAfter === '', foldersAfter);

await browser.close();
finish();
