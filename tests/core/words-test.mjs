// Word editing with real keys and clicks through @browser-lite/core, like Chrome on Linux (patch
// 0145, tools/icu-word-rules.cpp): Ctrl+Backspace and Ctrl+Delete in a text field, Ctrl+Arrow
// stops and a double click on a word. Punctuation ends a word and a run of it is one stop, a full
// stop between letters separates them. Before, one Ctrl+Backspace took "world, " of
// "hello world, " and a double click on "example" selected "example.com". The details of the
// rules are in tests/engine/pages/word-boundaries.html.
//
//   node tests/core/words-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Words test</title>
<body style="margin: 0; font: 18px monospace">
<input id="field" autocomplete="off" style="position: absolute; left: 20px; top: 20px; width: 600px; height: 30px; font: 18px monospace">
<p id="mail" style="position: absolute; left: 20px; top: 100px; margin: 0">mail user@example.com now</p>
<p id="quote" style="position: absolute; left: 20px; top: 150px; margin: 0">say don't now</p>
<script>
const field = document.getElementById('field');
window.put = (value, at) => {
  field.value = value;
  field.focus();
  field.setSelectionRange(at, at);
};
window.report = (key, value) =>
  console.log('RESULT ' + key + '=' + encodeURIComponent(JSON.stringify(value)));
report('ready', 1);
</script>`;

const { url } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'words-token-0123456789abcdef' });
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
const results = collect(page);
await openHost(page, stack.app({ url }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === '1');
const box = await canvasOrigin(page);

let n = 0;
/** Runs source in the page and returns the JSON value it reports. */
async function read(source) {
  const key = `r${++n}`;
  await evalPage(page, `report('${key}', ${source})`);
  const value = await results.wait(key, 10000);
  return value === null ? null : JSON.parse(decodeURIComponent(value));
}

/** The value of source once it differs from before (the key goes through the host first). */
async function readChanged(source, before) {
  let value = before;
  for (let i = 0; i < 20 && value === before; i++) {
    await page.waitForTimeout(100);
    value = await read(source);
  }
  return value;
}

// Values and what Chromium leaves after the key, the caret at the end (at the start for Delete)
const BACKSPACE = {
  'hello world, ': 'hello world',
  'user@example.com': 'user@example.',
  'see foo.bar': 'see foo.',
  'path/to/file.txt': 'path/to/file.',
  'end. ': 'end',
  '<angle> @#$%^&*()...,. ': '<angle> ',
};
const DELETE = { 'foo.bar baz': '.bar baz', '... next': ' next' };
const LEFT = { 'hello world, ': 11, 'user@example.com': 13, 'see foo.bar': 8, 'end. ': 3 };
const RIGHT = { 'hello world, ': 5, ', next': 1, 'foo.bar': 3 };

await page.mouse.click(box.x + 300, box.y + 35);
for (const [value, expected] of Object.entries(BACKSPACE)) {
  await evalPage(page, `put(${JSON.stringify(value)}, ${value.length})`);
  await page.keyboard.press('Control+Backspace');
  const left = await readChanged('field.value', value);
  check(`Ctrl+Backspace on ${JSON.stringify(value)}`, left === expected, JSON.stringify(left));
}
for (const [value, expected] of Object.entries(DELETE)) {
  await evalPage(page, `put(${JSON.stringify(value)}, 0)`);
  await page.keyboard.press('Control+Delete');
  const left = await readChanged('field.value', value);
  check(`Ctrl+Delete on ${JSON.stringify(value)}`, left === expected, JSON.stringify(left));
}
for (const [value, expected] of Object.entries(LEFT)) {
  await evalPage(page, `put(${JSON.stringify(value)}, ${value.length})`);
  await page.keyboard.press('Control+ArrowLeft');
  const at = await readChanged('field.selectionStart', value.length);
  check(`Ctrl+ArrowLeft from the end of ${JSON.stringify(value)}`, at === expected, String(at));
}
for (const [value, expected] of Object.entries(RIGHT)) {
  await evalPage(page, `put(${JSON.stringify(value)}, 0)`);
  await page.keyboard.press('Control+ArrowRight');
  const at = await readChanged('field.selectionStart', 0);
  check(`Ctrl+ArrowRight from the start of ${JSON.stringify(value)}`, at === expected, String(at));
}

// Double click on the "x" of "example" (monospace: "mail user@e" is 11 characters)
const width = await read(`document.getElementById('mail').getBoundingClientRect().width / 25`);
await page.mouse.click(box.x + 700, box.y + 400);
await page.waitForTimeout(600);
await page.mouse.dblclick(box.x + 20 + width * 11.5, box.y + 110);
let selected = null;
for (let i = 0; i < 20 && selected !== 'example'; i++) {
  await page.waitForTimeout(100);
  selected = await read('getSelection().toString()');
}
check('double click selects "example" of user@example.com', selected === 'example', selected);

// On the apostrophe of "don't" ("say don" is 7 characters): the whole word, like Chrome
await page.mouse.click(box.x + 700, box.y + 400);
await page.waitForTimeout(600);
await page.mouse.dblclick(box.x + 20 + width * 7.5, box.y + 160);
for (let i = 0; i < 20 && selected !== "don't"; i++) {
  await page.waitForTimeout(100);
  selected = await read('getSelection().toString()');
}
check('double click on the apostrophe selects "don\'t"', selected === "don't", selected);

await browser.close();
finish();
