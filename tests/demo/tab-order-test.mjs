// Reordering tabs like Chrome and Firefox: a tab dragged with the mouse takes the place it is
// dropped at and slides into it, a click without movement only activates it, a press on its cross
// never drags, Ctrl+Shift+PageDown and PageUp move the active tab, and the session keeps the new
// order after the demo opens again. Closing the active tab activates its right neighbour (the left
// one at the end), or the tab it was opened from while no other tab was active in between.
//
//   node tests/demo/tab-order-test.mjs [engine-dir]
import {
  TIMEOUT,
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

const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1).toUpperCase();
  if (!/^[A-D]$/.test(name)) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'order-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const titles = () => page.locator('#tab-list .tab .title').allTextContents();
const order = async () => (await titles()).join('');
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent);
const orderIs = (expected) =>
  page
    .waitForFunction(
      (expected) =>
        [...document.querySelectorAll('#tab-list .tab .title')]
          .map((title) => title.textContent)
          .join('') === expected,
      expected,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
const sessionOrder = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('bl-session') ?? '{"tabs":[]}')
      .tabs.map((tab) => tab.title)
      .join(''),
  );
const box = async (title) => {
  const tabs = page.locator('#tab-list .tab');
  const index = (await titles()).indexOf(title);
  return tabs.nth(index).boundingBox();
};
// Presses the middle of a tab, moves by dx in steps and releases
async function drag(title, dx) {
  const from = await box(title);
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + (dx * step) / 10, y);
  await page.mouse.up();
}

await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', (await results.wait('ready', TIMEOUT)) === 'A');
for (const name of ['b', 'c', 'd']) {
  results.delete('ready');
  await page.keyboard.press('Control+t');
  await page.click('#address');
  await page.fill('#address', `${siteURL}${name}`);
  await page.press('#address', 'Enter');
  await results.wait('ready');
}
check('four tabs', await orderIs('ABCD'), await order());

// A click without movement only activates
const c = await box('C');
await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
check(
  'click: activates, the order stays',
  (await activeTitle()) === 'C' && (await order()) === 'ABCD',
  `${await activeTitle()}, ${await order()}`,
);

// The first tab dragged right over two tabs
const width = (await box('A')).width;
await drag('A', width * 2);
check('drag right over two tabs: it takes their place', await orderIs('BCAD'), await order());
check('drag: the dragged tab is active', (await activeTitle()) === 'A', await activeTitle());
await page.waitForTimeout(500);
const settled = await page.evaluate(() =>
  [...document.querySelectorAll('#tab-list .tab')].every(
    (tab) => !tab.classList.contains('dragging') && getComputedStyle(tab).translate === 'none',
  ),
);
check('drop: the tab slides into its place', settled);
check('drag: the session keeps the order', (await sessionOrder()) === 'BCAD', await sessionOrder());

// The last tab dragged left past the start (to the edge of the window) stops at the first place
const d = await box('D');
await drag('D', 2 - d.x - d.width / 2);
check('drag left past the start: the first place', await orderIs('DBCA'), await order());

// Less than the threshold, and a press on the cross: no move
await drag('B', 3);
check('a small movement is a click', (await order()) === 'DBCA', await order());
const close = page.locator('#tab-list .tab.active .close');
const closeBox = await close.boundingBox();
await page.mouse.move(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
await page.mouse.down();
await page.mouse.move(closeBox.x + closeBox.width / 2 + width, closeBox.y + closeBox.height / 2);
await page.mouse.move(closeBox.x + 400, closeBox.y + 300);
await page.mouse.up();
check('a press on the cross never drags', (await order()) === 'DBCA', await order());

// Keyboard like Chrome
await page.locator('#tab-list .tab').first().click();
await page.keyboard.press('Control+Shift+PageUp');
check('Ctrl+Shift+PageUp at the start: stays', (await order()) === 'DBCA', await order());
await page.keyboard.press('Control+Shift+PageDown');
check('Ctrl+Shift+PageDown: one place right', await orderIs('BDCA'), await order());
await page.keyboard.press('Control+Shift+PageDown');
await page.keyboard.press('Control+Shift+PageUp');
check('Ctrl+Shift+PageUp: one place left', await orderIs('BDCA'), await order());
check('keyboard: the moved tab stays active', (await activeTitle()) === 'D', await activeTitle());

// The order survives opening the demo again
await page.waitForTimeout(500);
results.delete('ready');
await page.goto(stack.app());
await results.wait('ready', TIMEOUT);
check('session: the restored tabs keep the order', await orderIs('BDCA'), await order());

// Closing the active tab like Chrome and Firefox
const tabCount = (count) =>
  page
    .waitForFunction(
      (count) => document.querySelectorAll('#tab-list .tab').length === count,
      count,
      {
        timeout: 10000,
      },
    )
    .then(
      () => true,
      () => false,
    );
await page.locator('#tab-list .tab').nth(1).click();
await page.locator('#tab-list .tab.active .close').click();
check('close: the order', await orderIs('BCA'), await order());
check(
  'close: the right neighbour becomes active',
  (await activeTitle()) === 'C',
  await activeTitle(),
);
await page.locator('#tab-list .tab').nth(2).click();
await page.keyboard.press('Control+w');
check('close the last tab: the order', await orderIs('BC'), await order());
check('close the last tab: the left neighbour', (await activeTitle()) === 'C', await activeTitle());
await page.locator('#tab-list .tab').first().click();
await page.keyboard.press('Control+t');
await tabCount(3);
await page.keyboard.press('Control+w');
await tabCount(2);
check('Ctrl+T, Ctrl+W: back to the opener', (await activeTitle()) === 'B', await activeTitle());
await page.keyboard.press('Control+t');
await tabCount(3);
await page.locator('#tab-list .tab').nth(1).click();
await page.locator('#tab-list .tab').nth(2).click();
await page.keyboard.press('Control+w');
await tabCount(2);
check(
  'after switching tabs the opener is forgotten: the left neighbour',
  (await activeTitle()) === 'C',
  await activeTitle(),
);

await browser.close();
finish();
