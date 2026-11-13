// Single entries of the history panel (Ctrl+H), like Chrome's Remove from history: every row has
// a remove button and a right click menu (Open in new tab, Remove from history). Removing drops
// the visits of that page on that day only, the keyboard moves to the row that took its place,
// the panel keeps its scroll position and search, and links to a page without any visit left
// lose :visited. Bookmark rows get the same menu with Remove bookmark.
//
//   node tests/demo/history-panel-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1).toUpperCase();
  if (!/^[A-D]$/.test(name)) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><title>Page ${name}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'histpanel-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

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
// "Day:Title" of the rows of the panel, in order
const rows = () =>
  page.evaluate(() => {
    let day = '';
    const result = [];
    for (const node of document.querySelectorAll('#side-panel .panel-list > *')) {
      if (node.matches('.panel-day')) day = node.textContent;
      else if (node.matches('.panel-row'))
        result.push(`${day}:${node.querySelector('.panel-title').textContent}`);
    }
    return result;
  });
const row = (title) => page.locator('#side-panel .panel-row', { hasText: title });
const menuRows = () =>
  page.evaluate(() =>
    [...(document.querySelector('.bl-context-menu')?.children ?? [])].map((node) =>
      node.tagName === 'HR' ? '-' : node.textContent,
    ),
  );
const choose = (item) => page.click(`.bl-context-menu [data-bl-item="${item}"]`);
const storedURLs = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bl-history')).map((visit) => visit.url));
// :visited of a link in the page: red when visited, blue when not
const visitedAt = async (x) => {
  const [red, , blue] = await page.evaluate((x) => window.blTest.pagePixel(x, 50), x);
  return red > 200 && blue < 50 ? 'visited' : blue > 200 && red < 50 ? 'not visited' : 'unknown';
};

await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', await readyIs('A'));
for (const name of ['B', 'C', 'D']) check(`page ${name}`, await typeAddress(name));

// Links to A and B in page D: both visited (this engine loaded them)
await page.evaluate(
  ([a, b]) =>
    window.blTest.eval(
      `document.body.insertAdjacentHTML('afterbegin', '<style>a.v { position: fixed; top: 0; width: 100px; height: 100px; background: rgb(0, 0, 255) } a.v:visited { background: rgb(255, 0, 0) }</style><a class="v" style="left: 0" href="${a}"></a><a class="v" style="left: 100px" href="${b}"></a>')`,
    ),
  [`${siteURL}a`, `${siteURL}b`],
);
check(
  'links to visited pages are :visited',
  (await waitFor(async () => (await visitedAt(50)) === 'visited', 10000)) &&
    (await visitedAt(150)) === 'visited',
  `${await visitedAt(50)} ${await visitedAt(150)}`,
);

// Yesterday: a visit of A and many other pages, so the panel scrolls
await page.evaluate((siteURL) => {
  const noon = new Date();
  noon.setDate(noon.getDate() - 1);
  noon.setHours(12, 0, 0, 0);
  const earlier = Array.from({ length: 60 }, (_, i) => ({
    url: `${siteURL}old-${i}`,
    title: `Old page ${i}`,
    time: noon.getTime() - (60 - i) * 60000,
  }));
  const history = JSON.parse(localStorage.getItem('bl-history'));
  localStorage.setItem(
    'bl-history',
    JSON.stringify([
      ...earlier,
      { url: `${siteURL}a`, title: 'Page A', time: noon.getTime() },
      ...history,
    ]),
  );
}, siteURL);

await page.keyboard.press('Control+h');
const firstRows = JSON.stringify([
  'Today:Page D',
  'Today:Page C',
  'Today:Page B',
  'Today:Page A',
  'Yesterday:Page A',
  'Yesterday:Old page 59',
]);
check(
  'history panel: today D, C, B, A, yesterday A first',
  await waitFor(async () => JSON.stringify((await rows()).slice(0, 6)) === firstRows, 5000),
  JSON.stringify((await rows()).slice(0, 6)),
);
const removeButtons = await page.evaluate(() =>
  [...document.querySelectorAll('#side-panel .panel-row')].map((row) => {
    const button = row.querySelector('.panel-remove');
    return button ? `${button.title}|${button.getAttribute('aria-label')}` : null;
  }),
);
check(
  'every history row has a remove button',
  removeButtons.length === 65 &&
    removeButtons[0] === 'Remove from history|Remove from history: Page D' &&
    removeButtons.every(Boolean),
  JSON.stringify(removeButtons.slice(0, 3)),
);

// The remove button of B: only B goes, the keyboard is on the row that took its place (A)
await row('Page B').locator('.panel-remove').focus();
await page.keyboard.press('Enter');
check(
  'remove button: the row is gone',
  JSON.stringify((await rows()).slice(0, 4)) ===
    JSON.stringify(['Today:Page D', 'Today:Page C', 'Today:Page A', 'Yesterday:Page A']),
  JSON.stringify((await rows()).slice(0, 4)),
);
check('remove button: no visit of B is stored', !(await storedURLs()).includes(`${siteURL}b`));
check(
  'remove button: the keyboard moves to the next row',
  await page.evaluate(
    () =>
      document.activeElement?.matches('.panel-remove') &&
      document.activeElement.closest('.panel-row').title.endsWith('/a'),
  ),
  await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)),
);
check(
  'a link to the removed page is no longer :visited, one to A still is',
  (await waitFor(async () => (await visitedAt(150)) === 'not visited', 10000)) &&
    (await visitedAt(50)) === 'visited',
  `${await visitedAt(50)} ${await visitedAt(150)}`,
);

// Right click on C: Open in new tab and Remove from history
await row('Page C').locator('.panel-link').click({ button: 'right' });
check(
  'right click on a row: its menu',
  JSON.stringify(await menuRows()) ===
    JSON.stringify(['Open in new tab', '-', 'Remove from history']),
  JSON.stringify(await menuRows()),
);
await choose('remove');
check(
  'menu: Remove from history',
  JSON.stringify((await rows()).slice(0, 3)) ===
    JSON.stringify(['Today:Page D', 'Today:Page A', 'Yesterday:Page A']),
  JSON.stringify((await rows()).slice(0, 3)),
);

// Today's A goes, yesterday's stays and keeps the link visited; then yesterday's goes too
await page
  .locator('#side-panel .panel-row', { hasText: 'Page A' })
  .first()
  .locator('.panel-remove')
  .click();
check(
  'only the visits of that day go',
  JSON.stringify((await rows()).slice(0, 2)) ===
    JSON.stringify(['Today:Page D', 'Yesterday:Page A']) &&
    (await storedURLs()).filter((url) => url === `${siteURL}a`).length === 1,
  JSON.stringify((await rows()).slice(0, 2)),
);
await new Promise((resolve) => setTimeout(resolve, 500));
check('a page visited on another day stays :visited', (await visitedAt(50)) === 'visited');
await row('Page A').locator('.panel-link').click({ button: 'right' });
await choose('remove');
check(
  'the last visit of A is gone, the link is no longer :visited',
  !(await storedURLs()).includes(`${siteURL}a`) &&
    (await waitFor(async () => (await visitedAt(50)) === 'not visited', 10000)),
  await visitedAt(50),
);

// Far down the list the panel keeps its scroll position
const scrolled = await page.evaluate(() => {
  const panel = document.getElementById('side-panel');
  panel.scrollTop = 1200;
  return panel.scrollTop;
});
const target = await page.evaluate(() => {
  const panel = document.getElementById('side-panel').getBoundingClientRect();
  const visible = [...document.querySelectorAll('#side-panel .panel-row')].find(
    (row) => row.getBoundingClientRect().top > panel.top + 100,
  );
  return visible?.querySelector('.panel-title').textContent;
});
await row(target).locator('.panel-remove').click();
const after = await page.evaluate(() => document.getElementById('side-panel').scrollTop);
check(
  'removing far down keeps the scroll position',
  scrolled > 0 &&
    Math.abs(after - scrolled) <= 1 &&
    !(await rows()).some((r) => r.endsWith(`:${target}`)),
  `${scrolled} -> ${after}, ${target}`,
);

// A search stays while a match is removed
await page.fill('#side-panel .panel-search', 'Old page 1');
await page.locator('#side-panel .panel-row').first().locator('.panel-remove').click();
const searched = await rows();
check(
  'removing keeps the search',
  (await page.inputValue('#side-panel .panel-search')) === 'Old page 1' &&
    searched.length === 10 &&
    searched.every((r) => r.includes('Old page 1')),
  JSON.stringify(searched),
);
await page.fill('#side-panel .panel-search', '');

// Open in new tab from the menu
results.delete('ready');
await row('Page D').locator('.panel-link').click({ button: 'right' });
await choose('open-new-tab');
check(
  'menu: Open in new tab',
  (await readyIs('D')) && (await page.locator('#tab-list .tab').count()) === 2,
  String(await page.locator('#tab-list .tab').count()),
);

// Bookmark rows: the same menu with Remove bookmark
await page.keyboard.press('Escape');
await page.click('#bookmark');
await page.keyboard.press('Control+Shift+O');
await row('Page D').locator('.panel-link').click({ button: 'right' });
check(
  'right click on a bookmark: its menu',
  JSON.stringify(await menuRows()) === JSON.stringify(['Open in new tab', '-', 'Remove bookmark']),
  JSON.stringify(await menuRows()),
);
await choose('remove');
check(
  'menu: Remove bookmark',
  (await page.locator('#side-panel .panel-row').count()) === 0 &&
    !(await page.evaluate(() => document.getElementById('bookmark').classList.contains('active'))),
);

await browser.close();
finish();
