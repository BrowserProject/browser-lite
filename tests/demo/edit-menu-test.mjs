// The edit commands and the search of the context menu like Chrome on the desktop: in a field
// Undo and Redo (enabled only with an edit to undo or redo), Cut, Copy, Paste, Paste as plain text
// and Select all; Paste brings the HTML of the host clipboard into a rich text field, Paste as
// plain text only its text; selected text offers Search <engine> for "<text>", which opens the
// search of the chosen engine in a new tab in front.
//
//   node tests/demo/edit-menu-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  permissions,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Edit menu</title>
<style>
body { margin: 0; font: 20px sans-serif }
#field { position: absolute; left: 20px; top: 20px; width: 300px; height: 30px; font: inherit }
#rich, #plain { position: absolute; top: 80px; width: 400px; height: 60px; border: 1px solid }
#rich { left: 20px }
#plain { left: 450px }
#text { position: absolute; left: 20px; top: 180px; margin: 0 }
</style>
<input id="field">
<div id="rich" contenteditable></div>
<div id="plain" contenteditable></div>
<p id="text">Private browsing</p>
<script>
const report = (name, value) => console.log('RESULT ' + name + '=' + encodeURIComponent(value));
field.addEventListener('input', () => report('field', field.value));
rich.addEventListener('input', () => report('rich', rich.innerHTML));
plain.addEventListener('input', () => report('plain', plain.innerHTML));
console.log('RESULT ready=1');
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'edit-menu-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: permissions(['clipboard-read', 'clipboard-write']),
});
const page = await context.newPage();
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');

const box = await canvasOrigin(page);
const at = (x, y) => [box.x + x, box.y + y];
const menuRows = async (x, y) => {
  await page.mouse.click(...at(x, y), { button: 'right' });
  const shown = await page
    .waitForSelector('.bl-context-menu', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) return [];
  return page
    .locator('.bl-context-menu .bl-menu-item')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => `${node.dataset.blItem}${node.disabled ? '(off)' : ''}:${node.textContent}`,
      ),
    );
};
const item = (id) => page.locator(`.bl-context-menu button[data-bl-item=${id}]`);
// Clicks an item of the open menu; a missing or disabled one closes the menu instead
const choose = async (id) => {
  if (
    await item(id)
      .isEnabled({ timeout: 1000 })
      .catch(() => false)
  )
    await item(id).click();
  else await page.keyboard.press('Escape');
};
const value = (name) => decodeURIComponent(results.get(name) ?? '');
const waitValue = (name, expected) =>
  waitFor(async () => value(name) === expected, 10000).then(() => value(name) === expected);

// A field without edits: Undo and Redo are there but disabled
await page.mouse.click(...at(100, 35));
let rows = await menuRows(100, 35);
check(
  'field menu like Chrome: Undo, Redo, Cut, Copy, Paste, Paste as plain text, Select all',
  rows.join('|') ===
    [
      'undo(off):Undo',
      'redo(off):Redo',
      'cut(off):Cut',
      'copy(off):Copy',
      'paste:Paste',
      'paste-plain:Paste as plain text',
      'select-all:Select all',
    ].join('|'),
  rows.join(' | '),
);
await page.keyboard.press('Escape');

// Typed text: Undo takes it back, then Redo brings it again
await page.mouse.click(...at(100, 35));
await page.keyboard.type('hello');
check('typed into the field', await waitValue('field', 'hello'), value('field'));
rows = await menuRows(100, 35);
check(
  'after typing: Undo enabled, Redo disabled',
  rows.includes('undo:Undo') && rows.includes('redo(off):Redo'),
  rows.join(' | '),
);
await screenshot(page, 'edit-menu-field');
await choose('undo');
check('Undo takes the typing back', await waitValue('field', ''), value('field'));
rows = await menuRows(100, 35);
check(
  'after Undo: Redo enabled',
  rows.includes('redo:Redo') && rows.includes('undo(off):Undo'),
  rows.join(' | '),
);
await choose('redo');
check('Redo brings it again', await waitValue('field', 'hello'), value('field'));

// Selected text in the field: Search <engine> for "<text>" after the edit commands
await page.mouse.dblclick(...at(40, 35));
rows = await menuRows(40, 35);
check(
  'selection in the field: the search last',
  rows.at(-1) === 'search:Search Bing for “hello”',
  rows.join(' | '),
);
await page.keyboard.press('Escape');

// Selected text on the page: Copy, Search, Select all, then the page commands
await page.mouse.dblclick(...at(40, 195));
rows = await menuRows(40, 195);
check(
  'selection on the page: Copy, Search Bing for the word, Select all',
  rows.slice(0, 3).join('|') ===
    ['copy:Copy', 'search:Search Bing for “Private”', 'select-all:Select all'].join('|'),
  rows.join(' | '),
);
await screenshot(page, 'edit-menu-search');
const tabs = () => page.locator('#tab-list .tab').count();
const tabsBefore = await tabs();
await choose('search');
let address = '';
await waitFor(async () => {
  address = await page.evaluate(() => document.getElementById('address').value);
  return address.includes('bing.com/search');
}, 10000);
check(
  'the search opens in a new tab in front',
  (await tabs()) === tabsBefore + 1 && address.includes('bing.com/search?q=Private'),
  `${await tabs()} tabs, ${address}`,
);
await page.locator('#tab-list .tab').first().click();
await page.waitForTimeout(500);

// Paste brings the HTML of the host clipboard into a rich field, Paste as plain text its text
if (chromiumOnly('Paste and Paste as plain text from the host clipboard')) {
  await page.evaluate(() =>
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(['bold text'], { type: 'text/plain' }),
        'text/html': new Blob(['<b>bold</b> text'], { type: 'text/html' }),
      }),
    ]),
  );
  await page.mouse.click(...at(200, 110));
  await menuRows(200, 110);
  await choose('paste');
  const bold = (name) => /<b\b|font-weight: ?(bold|700)/.test(value(name));
  check(
    'Paste: the HTML in a rich field',
    await waitFor(async () => bold('rich'), 10000).then(() => bold('rich')),
    value('rich'),
  );
  await page.mouse.click(...at(650, 110));
  await menuRows(650, 110);
  await choose('paste-plain');
  check(
    'Paste as plain text: only the text',
    await waitFor(async () => value('plain').includes('bold text'), 10000).then(
      () => value('plain').includes('bold text') && !bold('plain'),
    ),
    value('plain'),
  );
}

console.log(`(${BROWSER})`);
await browser.close();
finish();
