// A link dragged out of the page lands on the browser UI like in Chrome (core drag-out.ts, demo
// tab-drop.ts and address-bar.ts): dropped on the free part of the tab strip it opens in a new tab
// at the end, on a tab it loads in that tab, on the address bar it loads in the active tab. The
// page's dragend reports the drop (copy); dropped back on the page's own field it still inserts
// the address, and a drop outside any target reports none.
//
//   node tests/demo/link-drop-test.mjs [engine-dir]
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

const PAGE = `<!doctype html><title>D</title><style>body{margin:0}
a{display:block;font-size:30px;width:300px;height:60px}input{width:400px}</style>
<a href="/b">Link to B</a><input id="i">
<script>
document.addEventListener('dragend', (e) => console.log('RESULT end=' + e.dataTransfer.dropEffect));
document.getElementById('i').addEventListener('input', (e) => console.log('RESULT input=' + e.target.value));
console.log('RESULT ready=D');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  const b = req.url === '/b';
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      b
        ? `<!doctype html><title>B</title><p>B<script>console.log('RESULT ready=B')</script>`
        : PAGE,
    );
});

const stack = await startStack({ app: 'demo', token: 'linkdrop-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const waitFor = (fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: 15000 }).then(
    () => true,
    () => false,
  );
const titles = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent).join(','),
  );
const titlesAre = (expected) =>
  waitFor(
    (expected) =>
      [...document.querySelectorAll('#tab-list .tab .title')]
        .map((t) => t.textContent)
        .join(',') === expected,
    expected,
  );
const canvas = () =>
  page.evaluate(() => {
    const view = [...document.querySelectorAll('canvas[data-bl-view]')].find(
      (c) => c.offsetParent !== null,
    );
    const rect = view.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
const center = async (selector) => {
  const box = await page.locator(selector).first().boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
// Presses the mouse on the link of the active page and releases it at to
const dragLink = async (to) => {
  results.delete('end');
  const box = await canvas();
  const from = { x: box.x + 60, y: box.y + 30 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 20; step++)
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 20,
      from.y + ((to.y - from.y) * step) / 20,
    );
  await page.waitForTimeout(200);
  await page.mouse.up();
  return results.wait('end', 20000).catch(() => 'missing');
};
const openD = async () => {
  results.delete('ready');
  await page.fill('#address', `${siteURL}d`);
  await page.press('#address', 'Enter');
  return (await results.wait('ready', TIMEOUT)) === 'D';
};

await page.goto(stack.app({ url: `${siteURL}d` }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === 'D');

// Control: back onto the page's own field the address is inserted
const box = await canvas();
const end1 = await dragLink({ x: box.x + 100, y: box.y + 75 });
check(
  'dropped on the page field: inserted, dragend copy',
  end1 === 'copy' && (await results.wait('input', 10000)) === `${siteURL}b`,
  `${end1} ${results.get('input')}`,
);

// The free part of the tab strip: a new tab at the end, in front
const plus = await page.locator('#new-tab').boundingBox();
results.delete('ready');
const end2 = await dragLink({ x: plus.x + plus.width + 40, y: plus.y + plus.height / 2 });
check('dropped on the free strip: dragend copy', end2 === 'copy', end2);
check('a new tab with the link at the end', await titlesAre('D,B'), await titles());
check('the new tab is active and loads B', (await results.wait('ready', TIMEOUT)) === 'B');

// Another tab: the link loads there and it becomes active
check('the second tab shows D', (await openD()) && (await titlesAre('D,D')), await titles());
await page.locator('#tab-list .tab').first().click();
results.delete('ready');
const end3 = await dragLink(await center('#tab-list .tab:nth-child(2)'));
check('dropped on a tab: dragend copy', end3 === 'copy', end3);
check('the link loads in that tab', await titlesAre('D,B'), await titles());
check('B loaded', (await results.wait('ready', TIMEOUT)) === 'B');
check(
  'that tab is active',
  await waitFor(() =>
    document.querySelector('#tab-list .tab:nth-child(2)')?.classList.contains('active'),
  ),
);
check(
  'no tab stays marked as drop target',
  await page.evaluate(() => !document.querySelector('.tab.drop-target')),
);

// The address bar: the link loads in the active tab (the second)
check('page D again', (await openD()) && (await titlesAre('D,D')), await titles());
results.delete('ready');
const end4 = await dragLink(await center('#address'));
check('dropped on the address bar: dragend copy', end4 === 'copy', end4);
check('the active tab loads the link', (await results.wait('ready', TIMEOUT)) === 'B');
check(
  'the address bar shows it',
  await waitFor((url) => document.getElementById('address').value.includes(url), `${siteURL}b`),
  await page.inputValue('#address'),
);
check('no tab added, the first keeps D', await titlesAre('D,B'), await titles());

// No drop target (the toolbar's free space): nothing opens, dragend none
check('page D again', await openD());
const back = await page.locator('#back').boundingBox();
const end5 = await dragLink({ x: back.x + back.width / 2, y: back.y + back.height / 2 });
check('dropped where nothing accepts: dragend none', end5 === 'none', end5);
await page.waitForTimeout(500);
check('nothing opened', (await page.locator('#tab-list .tab').count()) === 2);

await browser.close();
finish();
