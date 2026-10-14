// End-to-End Test fuer die Zwischenablage (web/app.js paste/clipboard,
// engine/src/Exports.cpp bl_set_clipboard, WebCore PasteboardLibWPE.cpp):
// Einfuegen von Text, HTML und Bildern aus dem Host (paste-Ereignis der Seite,
// formatiert in contenteditable) und Kopieren mit HTML in die echte
// Zwischenablage. Dazu Doppel-/Dreifachklick (Klickzahl zaehlt der Host) und
// Texteingabe mit Vorschau (IME, ueber das DevTools-Protokoll).
//
//   cd tests/e2e && node clipboard-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'clipboard-token-0123456789abcdef';
const RELAY_PORT = 15841;
const UI_PORT = 15842;
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

const PAGE = `<!doctype html><title>Zwischenablage-Test</title>
<style>
body { margin: 0; font: 16px sans-serif }
#editor { position: absolute; left: 20px; top: 20px; width: 400px; height: 100px; border: 1px solid #888 }
#source { position: absolute; left: 20px; top: 200px; width: 400px; height: 40px }
#jp { position: absolute; left: 20px; top: 300px; width: 300px; height: 40px }
</style>
<div id="editor" contenteditable="true"></div>
<div id="source">Kopier <i>mich</i></div>
<textarea id="jp"></textarea>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
const editor = document.getElementById('editor');
editor.addEventListener('focus', () => log('focus', 1));
document.addEventListener('paste', async (e) => {
  const data = e.clipboardData;
  log('pastetypes', [...data.types].join(','));
  log('pastetext', data.getData('text/plain'));
  log('pastehtml', data.getData('text/html').includes('<b>fett</b>') ? 'ja' : 'nein:' + data.getData('text/html'));
  const files = [...data.files];
  const parts = [];
  for (const file of files)
    parts.push(file.name + ':' + file.type + ':' + (await file.arrayBuffer()).byteLength);
  log('pastefiles', parts.join('|'));
  setTimeout(() => log('editor', editor.innerHTML.includes('<b>fett</b>') ? 'formatiert' : editor.innerHTML), 300);
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
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
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

// 1. Einfuegen aus dem Host: Text, HTML und ein Bild (wie ein Screenshot)
await page.mouse.click(box.x + 200, box.y + 70);
check('Editor hat den Fokus', await result('focus') === '1');
await page.evaluate(() => {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', 'Hallo fett');
  dataTransfer.setData('text/html', '<meta charset="utf-8">Hallo <b>fett</b>');
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  dataTransfer.items.add(new File([png], 'image.png', { type: 'image/png' }));
  document.getElementById('ime').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
});
const types = await result('pastetypes');
check('paste: Typen wie Chrome (text/plain, text/html, Files)', types === 'text/plain,text/html,Files', types);
check('paste: getData("text/plain")', await result('pastetext') === 'Hallo_fett', results.get('pastetext'));
check('paste: getData("text/html")', await result('pastehtml') === 'ja', results.get('pastehtml'));
check('paste: Bild in clipboardData.files', await result('pastefiles') === 'image.png:image/png:70', results.get('pastefiles'));
check('Einfuegen in contenteditable ist formatiert', await result('editor') === 'formatiert', results.get('editor'));

// 2. Doppelklick markiert ein Wort (die Klickzahl zaehlt der Host selber)
await page.mouse.dblclick(box.x + 40, box.y + 210);
check('Doppelklick: dblclick mit detail 2, Wort markiert', await result('dblclick') === '2:Kopier', results.get('dblclick'));
await page.waitForTimeout(600);

// 3. Kopieren in der Seite: Text und HTML in der echten Zwischenablage
await page.mouse.click(box.x + 40, box.y + 215, { clickCount: 3 });
await page.keyboard.press('Control+c');
check('copy-Ereignis in der Seite', await result('copied') === '1', results.get('selection'));
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
check('Zwischenablage: Text', copied?.text?.trim() === 'Kopier mich', JSON.stringify(copied));
check('Zwischenablage: HTML mit Formatierung', /<i[^>]*>mich<\/i>/.test(copied?.html || ''), (copied?.html || '').slice(0, 120));

// 4. Eingabemethode (IME): Vorschau in der Seite, Kandidatenfenster beim Cursor
await page.mouse.click(box.x + 100, box.y + 320);
await page.waitForTimeout(300);
const cdp = await context.newCDPSession(page);
await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
await page.waitForTimeout(300);
await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
await page.waitForTimeout(300);
await cdp.send('Input.insertText', { text: '日本' });
// compositionupdate kommt vor der Aenderung im Feld (wie Chrome): beim zweiten
// steht die Vorschau "に" schon im Feld, vor dem Ende kommt der fertige Text
check('IME: compositionstart/update (Vorschau im Feld) und end', await result('composition') === 'start|update:に:|update:にほ:に|update:日本:にほ|end:日本|日本', results.get('composition'));
const imePlace = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const rect = canvas.getBoundingClientRect();
  const ime = document.getElementById('ime');
  return { x: parseFloat(ime.style.left) - rect.left, y: parseFloat(ime.style.top) - rect.top };
});
check('IME-Feld steht beim Cursor (fuer das Kandidatenfenster)', imePlace.x > 15 && imePlace.x < 80 && imePlace.y > 290 && imePlace.y < 340, JSON.stringify(imePlace));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
