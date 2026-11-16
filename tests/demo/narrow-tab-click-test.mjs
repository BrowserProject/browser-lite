// A click on a narrow background tab selects it like Chrome, at every width the tabs shrink to:
// while the title shows, the cross of a hovered tab sits at its right edge; once the title is
// gone the tab shows only its icon, so the middle of the tab is never the cross under the pointer.
//
//   node tests/demo/narrow-tab-click-test.mjs [engine-dir]
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

timeLimit(TIMEOUT * 3);

const TABS = 24;
const { url: siteURL } = await serve((_req, res) => {
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end("<!doctype html><title>A</title><p>A<script>console.log('RESULT ready=A')</script>");
});

const stack = await startStack({ app: 'demo', token: 'narrow-tab-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const waitFor = (fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: 10000 }).then(
    () => true,
    () => false,
  );
// The widths of the tabs no longer change (a new one has grown in)
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
/** The tab at index: its box, what shows and what is under its middle. */
const tabAt = (index) =>
  page.evaluate((index) => {
    const tabs = [...document.querySelectorAll('#tab-list .tab')];
    const tab = tabs[index];
    const box = tab.getBoundingClientRect();
    const close = tab.querySelector('.close');
    const closeBox = close.getBoundingClientRect();
    const middle = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      count: tabs.length,
      active: tabs.indexOf(document.querySelector('#tab-list .tab.active')),
      x: box.x,
      y: box.y,
      width: Math.round(box.width),
      height: box.height,
      title: getComputedStyle(tab.querySelector('.title')).display !== 'none',
      close: getComputedStyle(close).display !== 'none' && closeBox.width > 0,
      closeLeft: Math.round(closeBox.left - box.left),
      closeRight: Math.round(box.right - closeBox.right),
      middle: middle?.closest('.close')
        ? 'close'
        : middle?.closest('.tab') === tab
          ? 'tab'
          : 'other',
    };
  }, index);

await page.goto(stack.app({ url: siteURL }));
check('first page', await results.wait('ready'));

const seen = { hoverCross: 0, noTitle: 0 };
for (let count = 2; count <= TABS; count++) {
  await page.keyboard.press('Control+t');
  await waitFor((n) => document.querySelectorAll('#tab-list .tab').length === n, count);
  await settled();
  const probe = await tabAt(0);
  if (probe.width > 128) continue;
  // A background tab in view: the one next to the active tab, which the strip keeps in view
  const index = probe.active === 0 ? 1 : probe.active - 1;
  const before = await tabAt(index);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.waitForTimeout(200);
  const hovered = await tabAt(index);
  const label = `${count} tabs of ${hovered.width} px`;
  if (!hovered.title) seen.noTitle++;
  if (hovered.close) {
    seen.hoverCross++;
    check(
      `${label}: the cross of a hovered background tab sits at its right edge`,
      hovered.title && hovered.closeRight <= 8 && hovered.closeLeft > hovered.width / 2,
      JSON.stringify(hovered),
    );
  }
  check(
    `${label}: the middle of a background tab is the tab`,
    hovered.middle === 'tab',
    JSON.stringify(hovered),
  );
  await page.mouse.down();
  await page.mouse.up();
  const selected = await waitFor((index) => {
    const tabs = [...document.querySelectorAll('#tab-list .tab')];
    return tabs.indexOf(document.querySelector('#tab-list .tab.active')) === index;
  }, index);
  const after = await tabAt(index);
  check(
    `${label}: a click in the middle selects the tab`,
    selected && after.count === count,
    JSON.stringify(after),
  );
  await page.mouse.move(0, 400);
}
check('some widths show the cross of a hovered tab', seen.hoverCross > 0, JSON.stringify(seen));
check('some widths hide the titles', seen.noTitle > 0, JSON.stringify(seen));

await browser.close();
finish();
