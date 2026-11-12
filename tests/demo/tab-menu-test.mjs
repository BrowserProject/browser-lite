// The menu of a right click on the tab strip, like Chrome: on a tab New tab to the right, Reload,
// Duplicate, Mute tab, Close, Close other tabs, Close tabs to the right and Reopen closed tab; on
// the free part of the strip New tab and Reopen closed tab. The right press takes no focus, so the
// address bar keeps its edit; Escape closes the menu. Duplicate opens the page with back and
// forward right after its tab, Reload of a background tab loads it again without activating it,
// Close other tabs and Close tabs to the right keep the pressed tab and activate it when the
// active tab goes.
//
//   node tests/demo/tab-menu-test.mjs [engine-dir]
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

const loads = new Map();
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1).toUpperCase();
  if (!/^[A-F]$/.test(name)) return res.writeHead(404).end();
  loads.set(name, (loads.get(name) ?? 0) + 1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'tabmenu-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const waitFor = (fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: 10000 }).then(
    () => true,
    () => false,
  );
const order = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent).join(','),
  );
const orderIs = (expected) =>
  waitFor(
    (expected) =>
      [...document.querySelectorAll('#tab-list .tab .title')]
        .map((t) => t.textContent)
        .join(',') === expected,
    expected,
  );
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent);
const menuRows = () =>
  page.evaluate(() =>
    [...(document.querySelector('.bl-context-menu')?.children ?? [])].map((node) =>
      node.tagName === 'HR' ? '-' : `${node.textContent}${node.disabled ? ' (off)' : ''}`,
    ),
  );
const menuOpen = () => page.evaluate(() => !!document.querySelector('.bl-context-menu'));
const tabAt = (index) => page.locator('#tab-list .tab').nth(index);
const rightClick = (index) => tabAt(index).click({ button: 'right' });
const choose = (item) => page.click(`.bl-context-menu [data-bl-item=${item}]`);
const readyIs = async (name) => {
  for (const end = Date.now() + TIMEOUT; Date.now() < end; ) {
    if (results.get('ready') === name) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
const typeAddress = async (name) => {
  results.delete('ready');
  await page.click('#address');
  await page.fill('#address', `${siteURL}${name.toLowerCase()}`);
  await page.press('#address', 'Enter');
  return readyIs(name);
};

await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', await readyIs('A'));
for (const name of ['B', 'C', 'D']) {
  await page.keyboard.press('Control+t');
  await typeAddress(name);
}
check('four tabs', await orderIs('A,B,C,D'), await order());

// The menu of a tab; the right press keeps the keyboard with the page and an edit of the address
await page.click('#address');
await page.fill('#address', 'typed');
await page.locator('canvas[data-bl-view]:visible').click({ position: { x: 300, y: 300 } });
// The view's keyboard element lies in #pages
const focused = () =>
  page.evaluate(() => {
    const node = document.activeElement;
    return `${node?.tagName}#${node?.id}${document.getElementById('pages').contains(node) ? ' in the page' : ''}`;
  });
const pageFocus = await focused();
await rightClick(1);
check(
  'right click on a tab: its menu like Chrome',
  JSON.stringify(await menuRows()) ===
    JSON.stringify([
      'New tab to the right',
      '-',
      'Reload',
      'Duplicate',
      'Mute tab',
      '-',
      'Close',
      'Close other tabs',
      'Close tabs to the right',
      '-',
      'Reopen closed tab (off)',
    ]),
  JSON.stringify(await menuRows()),
);
check(
  'right press: the page keeps the keyboard',
  pageFocus.endsWith('in the page') && (await focused()) === pageFocus,
  `${pageFocus} -> ${await focused()}`,
);
check(
  'right press: the edit of the address stays',
  (await page.inputValue('#address')) === 'typed',
  await page.inputValue('#address'),
);
check('right press: the tab does not become active', (await activeTitle()) === 'D');
await page.keyboard.press('Escape');
check('Escape closes the menu', !(await menuOpen()));

// Reload of a background tab: its page loads again, the active tab stays
const before = loads.get('B');
await rightClick(1);
results.delete('ready');
await choose('reload');
check('Reload: the background tab loads again', await readyIs('B'), `${loads.get('B')}`);
check(
  'Reload: one more request, the active tab stays',
  loads.get('B') === before + 1 && (await activeTitle()) === 'D',
  `${before} -> ${loads.get('B')}, ${await activeTitle()}`,
);

// Duplicate with back and forward: C gets a second page first
await tabAt(2).click();
await typeAddress('E');
check('C went on to E', await orderIs('A,B,E,D'), await order());
await rightClick(2);
results.delete('ready');
await choose('duplicate');
check(
  'Duplicate: the copy right after its tab, in front',
  await orderIs('A,B,E,E,D'),
  await order(),
);
check(
  'Duplicate: the copy is active and loads its page',
  (await readyIs('E')) &&
    (await page.evaluate(() =>
      document.querySelectorAll('#tab-list .tab')[3]?.classList.contains('active'),
    )),
);
check(
  'Duplicate: back goes to the page before',
  await waitFor(() => !document.getElementById('back').disabled),
);
results.delete('ready');
await page.click('#back');
check('Duplicate: back loads C', await readyIs('C'));

// Mute tab, and the label of the next menu
await rightClick(0);
await choose('mute');
check('Mute tab: the view is muted', await waitFor(() => window.blTest.views()[0]?.muted === true));
await rightClick(0);
check(
  'a muted tab offers Unmute tab',
  (await menuRows()).includes('Unmute tab'),
  JSON.stringify(await menuRows()),
);
await choose('mute');
check('Unmute tab', await waitFor(() => window.blTest.views()[0]?.muted === false));

// New tab to the right
await rightClick(0);
await choose('new-tab-right');
check(
  'New tab to the right: after the tab, in front',
  await orderIs('A,New tab,B,E,C,D'),
  await order(),
);
check('New tab to the right: active', (await activeTitle()) === 'New tab', await activeTitle());

// Close tabs to the right of B while a tab right of it is active: B becomes active
await tabAt(4).click();
await rightClick(2);
await choose('close-right');
check('Close tabs to the right', await orderIs('A,New tab,B'), await order());
check(
  'Close tabs to the right: the pressed tab is active',
  (await activeTitle()) === 'B',
  await activeTitle(),
);

// Reopen closed tab is offered now, also on the free part of the strip
const strip = await page.locator('#tab-list').boundingBox();
const lastTab = await tabAt(2).boundingBox();
await page.mouse.click(lastTab.x + lastTab.width + 20, strip.y + strip.height / 2, {
  button: 'right',
});
check(
  'right click on the free strip: New tab and Reopen closed tab',
  JSON.stringify(await menuRows()) === JSON.stringify(['New tab', 'Reopen closed tab']),
  JSON.stringify(await menuRows()),
);
results.delete('ready');
await choose('reopen-closed');
// The three tabs closed together come back one at a time, like Ctrl+Shift+T
check(
  'Reopen closed tab: a closed tab comes back',
  await waitFor(() => {
    const titles = [...document.querySelectorAll('#tab-list .tab .title')].map(
      (t) => t.textContent,
    );
    return titles.length === 4 && ['C', 'D', 'E'].includes(titles[3]);
  }),
  await order(),
);

// Close other tabs keeps the pressed one
await rightClick(0);
await choose('close-others');
check('Close other tabs: only the pressed tab stays', await orderIs('A'), await order());
check('Close other tabs: it is active', (await activeTitle()) === 'A', await activeTitle());
await rightClick(0);
const single = await menuRows();
check(
  'one tab: Close other tabs and Close tabs to the right are off',
  single.includes('Close other tabs (off)') && single.includes('Close tabs to the right (off)'),
  JSON.stringify(single),
);
await choose('close');
check(
  'Close of the last tab: a new tab page instead, like closing it with its cross',
  await orderIs('New tab'),
  await order(),
);

await browser.close();
finish();
