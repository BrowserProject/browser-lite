// Keyboard focus between the toolbar and the page like Chrome: Tab and Shift+Tab in the address
// bar step through the toolbar's buttons next to it, Tab from the last one enters the page at its
// first element, Shift+Tab before the page's first element comes back to that last button, Tab
// past the page's last element goes to the address bar; F6 moves from the toolbar to the page
// (where it was) and from the page to the address bar.
//
//   node tests/demo/toolbar-focus-test.mjs [engine-dir]
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

timeLimit(TIMEOUT * 2);

const PAGE = `<!doctype html><title>Focus</title>
<form><input id=req required><button id=submit type=button>submit</button></form>
<button id=last type=button>last</button>
<script>console.log('RESULT ready=' + location.search.slice(1))</script>`;
const { url: siteURL } = await serve((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ app: 'demo', token: 'toolbar-focus-token-0123456789abcd' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: `${siteURL}?one` }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === 'one');
// A second entry, so Back is enabled and in the tab order
await page.evaluate((url) => window.blTest.load(url), `${siteURL}?two`);
results.delete('ready');
check('second page loaded', (await results.wait('ready', TIMEOUT)) === 'two');
await page.waitForFunction(() => !document.getElementById('back').disabled, null, {
  timeout: 5000,
});

let probe = 0;
/** Where the keyboard is: a host element, or `page:<id>` when the view has it. */
async function focus() {
  await page.waitForTimeout(300);
  const host = await page.evaluate(() =>
    window.blTest.view().focused ? '' : document.activeElement?.id || 'body',
  );
  if (host) return host;
  const key = `active${++probe}`;
  await page.evaluate(
    (key) =>
      window.blTest.eval(
        `console.log('RESULT ${key}=' + (document.activeElement && document.activeElement.id || 'body'))`,
      ),
    key,
  );
  return `page:${await results.wait(key, 5000)}`;
}
/** The keyboard positions after each of at most `count` presses of key, until the page has it. */
async function walk(key, count) {
  const seen = [];
  for (let i = 0; i < count && !seen.at(-1)?.startsWith('page:'); i++) {
    await page.keyboard.press(key);
    seen.push(await focus());
  }
  return seen;
}

// Shift+Tab from the address bar: Reload, then Back (Forward is disabled)
await page.click('#address');
const back = await walk('Shift+Tab', 2);
check(
  'Shift+Tab from the address bar: Reload, then Back',
  back[0] === 'reload' && back[1] === 'back',
  back.join(' > '),
);

// Tab from the address bar: the star, the toolbar's buttons up to the menu, then the page's first
// element
await page.click('#address');
const forward = await walk('Tab', 8);
const entered = forward.findIndex((at) => at.startsWith('page:'));
check(
  'Tab from the address bar: the star and the menu before the page',
  forward[0] === 'bookmark' && entered > 0 && forward[entered - 1] === 'menu-button',
  forward.join(' > '),
);
check('Tab from the last button: the first element of the page', forward[entered] === 'page:req');

// Shift+Tab before the page's first element: back to the menu button
await page.keyboard.press('Shift+Tab');
check('Shift+Tab before the first element: the menu button', (await focus()) === 'menu-button');

// The page's last element: Tab goes to the address bar
await page.keyboard.press('Tab');
check('Tab from the menu button again: the first element', (await focus()) === 'page:req');
await page.keyboard.press('Tab');
check('Tab: the next element of the page', (await focus()) === 'page:submit');
await page.keyboard.press('Tab');
check('Tab: the last element of the page', (await focus()) === 'page:last');
await page.keyboard.press('Tab');
check('Tab past the last element: the address bar', (await focus()) === 'address');

// F6: from the address bar to the page where its focus was, from the page to the address bar
const box = await canvasOrigin(page);
await page.mouse.click(box.x + 20, box.y + 18);
check('a click focuses the field', (await focus()) === 'page:req');
await page.click('#address');
await page.keyboard.press('F6');
check('F6 from the address bar: the page', (await focus()) === 'page:req');
await page.keyboard.type('abc');
const key = `typed${++probe}`;
await page.evaluate(
  (key) =>
    window.blTest.eval(`console.log('RESULT ${key}=' + document.getElementById('req').value)`),
  key,
);
check('keys after F6 reach the page', (await results.wait(key, 5000)) === 'abc');
await page.keyboard.press('F6');
check('F6 from the page: the address bar', (await focus()) === 'address');
await page.keyboard.press('Shift+F6');
check('Shift+F6 from the address bar: the page', (await focus()) === 'page:req');
await page.focus('#reload');
await page.keyboard.press('F6');
check('F6 from a toolbar button: the page', (await focus()) === 'page:req');

// Into the page again from the toolbar: its first element, not the one after the element the
// page had focused (Chrome clears the page's focus when Tab enters it)
await page.keyboard.press('Tab');
check('Tab in the page', (await focus()) === 'page:submit');
await page.keyboard.press('F6');
await page.focus('#menu-button');
await page.keyboard.press('Tab');
const again = await focus();
check('Tab enters the page at its first element again', again === 'page:req', again);

await browser.close();
finish();
