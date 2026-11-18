// Spell checking of text fields like Chrome: once a field has the focus, the misspelled words of
// its text get the red wavy underline, typed words when they are finished; a right click on one
// selects it and the context menu offers its corrections and Add to dictionary. A correction
// replaces the word as an edit with the input type insertReplacementText, an added word loses its
// underline and counts as correct in other fields too, also after a restart. Words in other
// scripts and spellcheck=false fields are not checked, a long text is checked in pieces to its
// end, and the preference spellcheck: false takes the underlines away.
//
//   node tests/demo/spelling-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const STYLE = 'font: 20px monospace; padding: 4px; border: 1px solid #888; width: 900px';
const PAGE = `<!doctype html><title>Spelling</title>
<style>
body { margin: 0 }
textarea, div.field { position: absolute; left: 20px; ${STYLE}; height: 32px; resize: none; white-space: pre; overflow: hidden; box-sizing: content-box; margin: 0; line-height: 26px }
#t { top: 30px } #off { top: 110px } #ed { top: 190px }
.mirror { position: absolute; visibility: hidden; white-space: pre; ${STYLE}; line-height: 26px; box-sizing: content-box; margin: 0 }
</style>
<textarea id="t" spellcheck="true">Thsi is a mispeled sentense</textarea>
<textarea id="off" spellcheck="false">Thsi is a mispeled sentense</textarea>
<div id="ed" class="field" contenteditable="true">Wrod in a contenteditible καλημέρα</div>
<div id="long" contenteditable="true" style="position: absolute; left: 20px; top: 260px; width: 960px; font: 8px monospace; line-height: 10px; margin: 0; padding: 0">${'fine '.repeat(900)}lastwrod</div>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const t = document.getElementById('t');
t.addEventListener('input', (event) => result('input' + event.inputType, encodeURIComponent(t.value)));
const long = document.getElementById('long');
window.longBox = () => { const box = long.getBoundingClientRect(); return { left: box.left, top: box.top, bottom: box.bottom }; };
// The words of a field and where they are: a hidden copy with the same font and box
window.words = (id) => {
  const field = document.getElementById(id);
  const text = field.value ?? field.textContent;
  const mirror = document.createElement('div');
  mirror.className = 'mirror';
  const rect = field.getBoundingClientRect();
  mirror.style.left = rect.left + 'px';
  mirror.style.top = rect.top + 'px';
  const boxes = [];
  for (const part of text.split(/( +)/)) {
    const span = document.createElement('span');
    span.textContent = part;
    mirror.append(span);
    if (part.trim()) boxes.push([part, span]);
  }
  document.body.append(mirror);
  const out = boxes.map(([word, span]) => {
    const box = span.getBoundingClientRect();
    return { word, left: box.left, right: box.right, top: rect.top, bottom: rect.bottom };
  });
  mirror.remove();
  return out;
};
result('ready', '1');
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else res.writeHead(404).end();
});

const browser = await launch();
const stack = await startStack({ app: 'demo', token: 'spelling-token-0123456789abcdef' });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === '1');
await page.waitForTimeout(1000);
const box = await canvasOrigin(page);

let calls = 0;
// Runs an expression in the page and returns its value (JSON)
const pageValue = async (expression) => {
  const key = `call${++calls}`;
  await page.evaluate(
    (source) => window.blTest.eval(source),
    `result(${JSON.stringify(key)}, JSON.stringify(${expression}))`,
  );
  return JSON.parse((await results.wait(key, 20000)) ?? 'null');
};

// The words of a field with a red underline: red pixels below the text, by word box
const underlined = async (id) => {
  const words = await pageValue(`words(${JSON.stringify(id)})`);
  if (!words?.length) return [];
  const red = new Set();
  for (let y = Math.round(words[0].top) + 14; y < Math.round(words[0].bottom); y++) {
    const row = await page.evaluate((y) => window.blTest.pageRow(y), y);
    row.forEach(([r, g, b], x) => {
      if (r > 150 && g < 110 && b < 110) red.add(x);
    });
  }
  return words
    .filter(({ left, right }) => [...red].some((x) => x >= left && x < right))
    .map(({ word }) => word);
};
const waitUnderlined = async (id, expected, ms = 30000) => {
  let last = [];
  await waitFor(async () => {
    last = await underlined(id);
    return last.join(' ') === expected.join(' ');
  }, ms);
  return last;
};

check('nothing underlined before a field has the focus', (await underlined('t')).length === 0);

// The focus: the text the field has is checked; typed words when they are finished
const wordAt = async (id, word) => {
  const found = (await pageValue(`words(${JSON.stringify(id)})`)).find((w) => w.word === word);
  return [box.x + (found.left + found.right) / 2, box.y + found.top + 18];
};
const end = await pageValue(`words('t').at(-1)`);
await page.mouse.click(box.x + end.right + 20, box.y + end.top + 18);
await page.keyboard.type(' and anothr wrod ', { delay: 30 });
const typed = await waitUnderlined('t', ['Thsi', 'mispeled', 'sentense', 'anothr', 'wrod']);
check(
  'misspelled words underlined: the text the field had and the typed words',
  typed.join(' ') === 'Thsi mispeled sentense anothr wrod',
  typed.join(' '),
);
await screenshot(page, 'spelling-underlines');

// The menu of a misspelled word: its corrections first, then Add to dictionary
const openMenu = async ([x, y]) => {
  await page.mouse.click(x, y, { button: 'right' });
  return page
    .waitForSelector('.bl-context-menu', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
};
const rows = () =>
  page
    .locator('.bl-context-menu .bl-menu-item')
    .evaluateAll((nodes) => nodes.map((node) => `${node.dataset.blItem}:${node.textContent}`));
const item = (id) => page.locator(`.bl-context-menu button[data-bl-item=${id}]`);

check('right click on "mispeled": menu', await openMenu(await wordAt('t', 'mispeled')));
const menu = await rows();
const suggestions = menu.filter((row) => row.startsWith('spelling-suggestion-'));
check(
  'menu: corrections of the word first, "misspelled" among them, at most 3',
  menu[0]?.startsWith('spelling-suggestion-0:') &&
    suggestions.some((row) => row.endsWith(':misspelled')) &&
    suggestions.length <= 3,
  menu.join(' | '),
);
check(
  'menu: Add to dictionary after the corrections, then the edit commands',
  menu[suggestions.length] === 'add-to-dictionary:Add to dictionary' &&
    menu.indexOf('undo:Undo') > suggestions.length,
  menu.join(' | '),
);
await screenshot(page, 'spelling-menu');
const correction = suggestions.find((row) => row.endsWith(':misspelled'))?.split(':')[0];
if (correction) await item(correction).click();
else await page.keyboard.press('Escape');
check(
  'a correction replaces the word as insertReplacementText',
  decodeURIComponent((await results.wait('inputinsertReplacementText', 10000)) ?? '') ===
    'Thsi is a misspelled sentense and anothr wrod ',
  results.get('inputinsertReplacementText'),
);
const corrected = await waitUnderlined('t', ['Thsi', 'sentense', 'anothr', 'wrod']);
check(
  'the corrected word has no underline, the others keep theirs',
  corrected.join(' ') === 'Thsi sentense anothr wrod',
  corrected.join(' '),
);

// Add to dictionary: the word is correct from now on, also in other fields
check('right click on "wrod": menu', await openMenu(await wordAt('t', 'wrod')));
if (await item('add-to-dictionary').count()) await item('add-to-dictionary').click();
else await page.keyboard.press('Escape');
const added = await waitUnderlined('t', ['Thsi', 'sentense', 'anothr']);
check(
  'Add to dictionary: the word loses its underline',
  added.join(' ') === 'Thsi sentense anothr',
  added.join(' '),
);

// spellcheck=false: nothing is checked
const offEnd = await pageValue(`words('off').at(-1)`);
await page.mouse.click(box.x + offEnd.right + 20, box.y + offEnd.top + 18);
await page.keyboard.type(' xyzzyq ', { delay: 30 });
await page.waitForTimeout(1500);
const off = await underlined('off');
check('spellcheck=false: no underline', off.length === 0, off.join(' '));

// A new start of the engine (the host page loaded again): the added word is still known. An
// editable element: its text is checked once it has the focus, the added word counts and a word
// in another script is not checked
await page.waitForTimeout(1000);
results.delete('ready');
await page.reload();
check('page loaded again', (await results.wait('ready', TIMEOUT)) === '1');
await page.waitForTimeout(1000);
Object.assign(box, await canvasOrigin(page));
await page.mouse.click(...(await wordAt('ed', 'in')));
const editable = await waitUnderlined('ed', ['contenteditible']);
check(
  'after a restart, contenteditable: its misspelled word underlined, not the added word (capitalized) or Greek',
  editable.join(' ') === 'contenteditible',
  editable.join(' '),
);

// A long text is checked in pieces: a misspelled word at its end (after 4500 characters) too
const longBox = await pageValue('longBox()');
const redRows = async (from, to) => {
  const found = [];
  for (let y = Math.round(from); y < Math.round(to); y++) {
    const row = await page.evaluate((y) => window.blTest.pageRow(y), y);
    if (row.some(([r, g, b]) => r > 150 && r - g > 60 && r - b > 60)) found.push(y);
  }
  return found;
};
await page.mouse.click(box.x + longBox.left + 10, box.y + longBox.top + 5);
let longRed = [];
await waitFor(async () => {
  longRed = await redRows(longBox.top, longBox.bottom + 6);
  return longRed.length > 0;
}, 30000);
await screenshot(page, 'spelling-long');
check(
  'a long text: the misspelled word at its end underlined, nothing before it',
  longRed.length > 0 && longRed.every((y) => y > longBox.bottom - 10),
  `${longRed.join(',')} (text ${Math.round(longBox.top)} to ${Math.round(longBox.bottom)})`,
);

// The preference off: the underlines go
await page.evaluate(() => window.blTest.browser.setPreferences({ spellcheck: false }));
const gone = await waitUnderlined('ed', []);
const goneField = await underlined('t');
check(
  'preference spellcheck false: no underlines',
  gone.length === 0 && goneField.length === 0,
  `${gone.join(' ')} / ${goneField.join(' ')}`,
);

console.log(`(${BROWSER})`);
await browser.close();
await stack.stop?.();
finish();
