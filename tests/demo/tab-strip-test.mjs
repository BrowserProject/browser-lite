// The scrolling tab strip like Chrome and Firefox: once the tabs have shrunk to their minimum
// width and no longer fit, a new tab in front is scrolled fully into view (not under the new tab
// button), so is a tab activated with Ctrl+1, Ctrl+9 or Ctrl+Tab, also while it grows in and
// after the window gets narrower. A strip the user scrolled stays put while nothing changes size,
// and the vertical mouse wheel over the strip scrolls it sideways.
//
//   node tests/demo/tab-strip-test.mjs [engine-dir]
import {
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

const TABS = 16;
const { url: siteURL } = await serve((_req, res) => {
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end("<!doctype html><title>A</title><p>A<script>console.log('RESULT ready=A')</script>");
});

const stack = await startStack({ app: 'demo', token: 'strip-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 700, height: 600 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const waitFor = (fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: 10000 }).then(
    () => true,
    () => false,
  );
// Where the active tab is against the visible part of the strip (inside its padding, which holds
// the curves of the active tab) and the new tab button
const measure = () =>
  page.evaluate(() => {
    const strip = document.getElementById('tab-list');
    const box = strip.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(strip).paddingLeft);
    const tabs = [...strip.querySelectorAll('.tab')];
    const active = strip.querySelector('.tab.active');
    const rect = active.getBoundingClientRect();
    const plus = document.getElementById('new-tab').getBoundingClientRect();
    return {
      index: tabs.indexOf(active),
      count: tabs.length,
      overflow: strip.scrollWidth - strip.clientWidth,
      scrollLeft: Math.round(strip.scrollLeft),
      tab: [Math.round(rect.left), Math.round(rect.right)],
      strip: [Math.round(box.left + inset), Math.round(box.right - inset)],
      plus: Math.round(plus.left),
    };
  });
const visible = (m) =>
  m.tab[0] >= m.strip[0] - 1 && m.tab[1] <= m.strip[1] + 1 && m.tab[1] <= m.plus;
// The widths of the tabs no longer change (the new one has grown in)
const settled = async () => {
  let last = '';
  for (let i = 0; i < 50; i++) {
    const widths = await page.evaluate(() =>
      [...document.querySelectorAll('#tab-list .tab')]
        .map((tab) => tab.getBoundingClientRect().width)
        .join(),
    );
    if (widths === last) return;
    last = widths;
    await page.waitForTimeout(100);
  }
};
const activeIs = (index) =>
  waitFor(
    (index) =>
      [...document.querySelectorAll('#tab-list .tab')].indexOf(
        document.querySelector('#tab-list .tab.active'),
      ) === index,
    index,
  );

await page.goto(stack.app({ url: siteURL }));
check('first page', await results.wait('ready'));
for (let i = 1; i < TABS; i++) {
  await page.keyboard.press('Control+t');
  await waitFor((n) => document.querySelectorAll('#tab-list .tab').length === n, i + 1);
}
await settled();
const opened = await measure();
check(
  `the ${TABS} tabs overflow the strip`,
  opened.count === TABS && opened.overflow > 0,
  JSON.stringify(opened),
);
check(
  'the new tab in front is fully in view',
  opened.index === TABS - 1 && visible(opened),
  JSON.stringify(opened),
);

// The user scrolls back to the start: the strip stays there while nothing changes size
await page.evaluate(() => {
  document.getElementById('tab-list').scrollLeft = 0;
});
await page.waitForTimeout(500);
check('a scrolled strip stays put', (await measure()).scrollLeft === 0);

await page.keyboard.press('Control+9');
await activeIs(TABS - 1);
const last = await measure();
check('Ctrl+9 scrolls the last tab into view', visible(last), JSON.stringify(last));

// From the scrolled end of the strip to the first tab
await page.evaluate(() => {
  const strip = document.getElementById('tab-list');
  strip.scrollLeft = strip.scrollWidth;
});
await page.keyboard.press('Control+1');
await activeIs(0);
const first = await measure();
check(
  'Ctrl+1 scrolls the first tab into view',
  visible(first) && first.scrollLeft === 0,
  JSON.stringify(first),
);

await page.keyboard.press('Control+Shift+Tab');
await activeIs(TABS - 1);
const wrapped = await measure();
check(
  'Ctrl+Shift+Tab to the last tab scrolls it into view',
  visible(wrapped),
  JSON.stringify(wrapped),
);

// The window gets narrower: the active tab at the end stays in view
await page.setViewportSize({ width: 650, height: 600 });
await settled();
const narrow = await measure();
check('a narrower window keeps the active tab in view', visible(narrow), JSON.stringify(narrow));

// The vertical wheel over the strip scrolls it sideways
await page.evaluate(() => {
  document.getElementById('tab-list').scrollLeft = 0;
});
const box = await page.locator('#tab-list').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, 120);
check(
  'the mouse wheel scrolls the strip',
  await waitFor(() => document.getElementById('tab-list').scrollLeft > 0),
);

await browser.close();
finish();
