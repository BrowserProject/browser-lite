// Clipboard (paste and clipboard of the core, engine/src/Exports.cpp bl_set_clipboard, WebCore
// PasteboardLibWPE.cpp): paste text, HTML and images from the host (paste event of the page,
// formatted in contenteditable) and copy with HTML into the real clipboard. Also double and
// triple click (the core counts the clicks) and text input with a preview (IME, through the
// DevTools protocol).
//
//   node tests/core/clipboard-test.mjs [engine-dir]
import {
  BROWSER,
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  openHost,
  permissions,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Clipboard test</title>
<style>
body { margin: 0; font: 16px sans-serif }
#editor { position: absolute; left: 20px; top: 20px; width: 400px; height: 100px; border: 1px solid #888 }
#source { position: absolute; left: 20px; top: 200px; width: 400px; height: 40px }
#jp { position: absolute; left: 20px; top: 300px; width: 300px; height: 40px }
</style>
<div id="editor" contenteditable="true"></div>
<div id="source">Copy <i>me</i></div>
<textarea id="jp"></textarea>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
const editor = document.getElementById('editor');
editor.addEventListener('focus', () => log('focus', 1));
document.addEventListener('paste', async (e) => {
  const data = e.clipboardData;
  log('pastetypes', [...data.types].join(','));
  log('pastetext', data.getData('text/plain'));
  log('pastehtml', data.getData('text/html').includes('<b>bold</b>') ? 'yes' : 'no:' + data.getData('text/html'));
  const files = [...data.files];
  const parts = [];
  for (const file of files)
    parts.push(file.name + ':' + file.type + ':' + (await file.arrayBuffer()).byteLength);
  log('pastefiles', parts.join('|'));
  setTimeout(() => log('editor', editor.innerHTML.includes('<b>bold</b>') ? 'formatted' : editor.innerHTML), 300);
});
document.getElementById('source').addEventListener('dblclick', (e) => log('dblclick', e.detail + ':' + getSelection().toString()));
const jp = document.getElementById('jp');
const composition = [];
jp.addEventListener('compositionstart', () => composition.push('start'));
jp.addEventListener('compositionupdate', (e) => composition.push('update:' + e.data + ':' + jp.value));
jp.addEventListener('compositionend', (e) => {
  composition.push('end:' + e.data);
  setTimeout(() => log('composition', composition.join('|') + '|' + jp.value), 100);
});
document.addEventListener('copy', () => { log('selection', getSelection().toString()); log('copied', 1); });
log('ready', 1);
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'clipboard-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: permissions(['clipboard-read', 'clipboard-write']),
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms = 20000) => results.wait(key, ms);

await openHost(page, stack.app({ url: siteURL }));
check('page loaded', (await result('ready', TIMEOUT)) === '1');
const box = await canvasOrigin(page);

// 1. Paste from the host: text, HTML and an image (like a screenshot)
await page.mouse.click(box.x + 200, box.y + 70);
check('editor has the focus', (await result('focus')) === '1');
// Firefox gives an untrusted paste event no data: there the paste comes for real from the
// clipboard, which encodes the image again
const realPaste = BROWSER === 'firefox';
await page.evaluate(async (realPaste) => {
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );
  const html = '<meta charset="utf-8">Hello <b>bold</b>';
  if (realPaste) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(['Hello bold'], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
        'image/png': new Blob([png], { type: 'image/png' }),
      }),
    ]);
    return;
  }
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', 'Hello bold');
  dataTransfer.setData('text/html', html);
  dataTransfer.items.add(new File([png], 'image.png', { type: 'image/png' }));
  document.activeElement.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
  );
}, realPaste);
if (realPaste) await page.keyboard.press('Control+v');
const types = await result('pastetypes');
check(
  'paste: types like Chrome (text/plain, text/html, Files)',
  types === 'text/plain,text/html,Files',
  types,
);
check(
  'paste: getData("text/plain")',
  (await result('pastetext')) === 'Hello_bold',
  results.get('pastetext'),
);
check(
  'paste: getData("text/html")',
  (await result('pastehtml')) === 'yes',
  results.get('pastehtml'),
);
const pastedFiles = await result('pastefiles');
check(
  'paste: image in clipboardData.files',
  realPaste
    ? /^image\.png:image\/png:\d+$/.test(pastedFiles)
    : pastedFiles === 'image.png:image/png:70',
  pastedFiles,
);
check(
  'paste into contenteditable is formatted',
  (await result('editor')) === 'formatted',
  results.get('editor'),
);

// 2. A double click selects a word (the core counts the clicks itself)
await page.mouse.dblclick(box.x + 40, box.y + 210);
check(
  'double click: dblclick with detail 2, word selected',
  (await result('dblclick')) === '2:Copy',
  results.get('dblclick'),
);
await page.waitForTimeout(600);

// 3. Copy in the page: text and HTML in the real clipboard
await page.mouse.click(box.x + 40, box.y + 215, { clickCount: 3 });
await page.keyboard.press('Control+c');
check('copy event in the page', (await result('copied')) === '1', results.get('selection'));
let copied = null;
for (let i = 0; i < 25 && !copied?.html; i++) {
  await page.waitForTimeout(200);
  copied = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      const out = { types: items[0]?.types.join(',') };
      if (items[0]?.types.includes('text/html'))
        out.html = await (await items[0].getType('text/html')).text();
      if (items[0]?.types.includes('text/plain'))
        out.text = await (await items[0].getType('text/plain')).text();
      return out;
    } catch (e) {
      return { error: e.message };
    }
  });
}
check('clipboard: text', copied?.text?.trim() === 'Copy me', JSON.stringify(copied));
check(
  'clipboard: HTML with formatting',
  /<i[^>]*>me<\/i>/.test(copied?.html || ''),
  (copied?.html || '').slice(0, 120),
);

// 4. Input method (IME): preview in the page, candidate window at the cursor
if (chromiumOnly('input method (CDP Input.imeSetComposition)')) {
  await page.mouse.click(box.x + 100, box.y + 320);
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(300);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(300);
  await cdp.send('Input.insertText', { text: '日本' });
  // compositionupdate comes before the change in the field (like Chrome): at the second one the
  // preview of the first character is already in the field, before the end comes the finished text
  check(
    'IME: compositionstart/update (preview in the field) and end',
    (await result('composition')) ===
      'start|update:に:|update:にほ:に|update:日本:にほ|end:日本|日本',
    results.get('composition'),
  );
  const imePlace = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
      (c) => c.style.display !== 'none',
    );
    const rect = canvas.getBoundingClientRect();
    const ime = canvas.nextElementSibling;
    return { x: parseFloat(ime.style.left) - rect.left, y: parseFloat(ime.style.top) - rect.top };
  });
  check(
    'IME field at the cursor (for the candidate window)',
    imePlace.x > 15 && imePlace.x < 80 && imePlace.y > 290 && imePlace.y < 340,
    JSON.stringify(imePlace),
  );
}

await browser.close();
finish();
