// The find bar on a long page: the count always belongs to the text in the bar (a result of an
// earlier search never shows next to new text), opening the bar again does not search the old
// text before the new one, and a count past the engine's limit of 1000 shows as "1000+".
//
//   node tests/demo/find-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Three words without a common letter, each prefix of a word matches as often as the word:
// "kkk" in the first 1500 lines, then "qwx" 100 and "jvz" 150 times. The rest has none of the letters.
const lines = [];
for (let i = 0; i < 3000; i++) {
  let line = `line ${i}`;
  if (i < 1500) line += ' kkk';
  if (i >= 1500 && i % 15 === 0) line += ' qwx';
  if (i >= 1500 && i % 10 === 1) line += ' jvz';
  lines.push(`<div>${line}</div>`);
}
const totals = { k: '1000+', q: '100', j: '150' };
const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>long</title><body style="font:12px monospace">${lines.join('')}<script>console.log('RESULT ready=1')</script>`,
    ),
);

const stack = await startStack({ app: 'demo', token: 'find-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('long page loaded', (await results.wait('ready', TIMEOUT)) === '1');
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 300, box.y + 300);

// Every text and count the bar shows, and the searches the view gets
await page.evaluate(() => {
  const input = document.getElementById('find-input');
  const count = document.getElementById('find-count');
  window.shown = [];
  const note = () => window.shown.push([input.value, count.textContent]);
  input.addEventListener('input', note);
  new MutationObserver(note).observe(count, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.searches = [];
  const view = window.blTest.view();
  const find = view.find.bind(view);
  view.find = (text, options) => {
    window.searches.push(text);
    find(text, options);
  };
});
const count = () => page.evaluate(() => document.getElementById('find-count').textContent);
const countIs = (pattern) =>
  page
    .waitForFunction(
      (source) => new RegExp(source).test(document.getElementById('find-count').textContent),
      pattern.source,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    );

// The page gets Ctrl+F first, the bar opens when it does not handle it
const openBar = async (key) => {
  await page.keyboard.press(key);
  await page.waitForFunction(() => document.activeElement?.id === 'find-input', null, {
    timeout: 10000,
  });
};
await openBar('Control+f');
await page.keyboard.type('qwx');
check('first search counts', await countIs(/^\d+ of 100$/), await count());
const first = await count();
await page.keyboard.press('Enter');
check(
  'Enter: next match',
  await countIs(new RegExp(`^${Number.parseInt(first) + 1} of 100$`)),
  `${first} then ${await count()}`,
);
await page.keyboard.press('Escape');

// Opened again: the old text is selected and not searched, typing replaces it
await openBar('Control+f');
await page.waitForTimeout(500);
const reopened = {
  count: await count(),
  searches: await page.evaluate(() => window.searches.length),
};
check(
  'opened again: no search of the old text',
  reopened.count === '' && reopened.searches === 2,
  JSON.stringify(reopened),
);
await page.keyboard.type('jvz');
check('second search counts', await countIs(/^\d+ of 150$/), await count());
const searches = await page.evaluate(() => window.searches.slice(2));
check('opened again: only the new text searched', searches.join() === 'jvz', searches.join());

// Past the limit: "1000+"; the next match from the last one is the first on the page
await page.keyboard.press('Control+a');
await page.keyboard.type('kkk');
check('count past the limit shows 1000+', await countIs(/^1 of 1000\+$/), await count());

// F3 with the bar closed opens it and goes to the next match
await page.keyboard.press('Escape');
await openBar('F3');
check('F3: opens the bar and finds the next', await countIs(/^2 of 1000\+$/), await count());

const shown = await page.evaluate(() => window.shown);
const stale = shown.filter(
  ([text, shownCount]) => shownCount && !shownCount.endsWith(` of ${totals[text[0]]}`),
);
check(
  'the count always belongs to the text in the bar',
  shown.length > 0 && stale.length === 0,
  JSON.stringify(stale.slice(0, 5)),
);

await browser.close();
finish();
