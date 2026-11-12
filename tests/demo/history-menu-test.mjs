// The list of a tab's back and forward pages, like Chrome: a right click on Back shows the earlier
// pages nearest first and Show full history, a right click on Forward the later ones; the right
// press keeps the keyboard with the page. A chosen entry is reached in one step (no page in
// between is shown). A held press opens the list too, and its release does not go back as well;
// Enter on the focused button still goes back. Show full history opens the history panel;
// view.go beyond the history does nothing.
//
//   node tests/demo/history-menu-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Requests per page; every show of a page logs ready, also one from the back/forward cache
const loads = new Map();
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1).toUpperCase();
  if (!/^[A-D]$/.test(name)) return res.writeHead(404).end();
  loads.set(name, (loads.get(name) ?? 0) + 1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><title>Page ${name}</title><p>${name}<script>addEventListener('pageshow', () => console.log('RESULT ready=${name}'))</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'histmenu-token-0123456789abcdef' });
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
const menuRows = () =>
  page.evaluate(() =>
    [...(document.querySelector('.bl-context-menu')?.children ?? [])].map((node) =>
      node.tagName === 'HR' ? '-' : node.textContent,
    ),
  );
const menuOpen = () => page.evaluate(() => !!document.querySelector('.bl-context-menu'));
const choose = (item) => page.click(`.bl-context-menu [data-bl-item="${item}"]`);
const readyIs = async (name) => {
  for (const end = Date.now() + TIMEOUT; Date.now() < end; ) {
    if (results.get('ready') === name) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
// The pages shown since the mark
const shownSince = (mark) =>
  results.logs
    .slice(mark)
    .map((line) => /RESULT ready=(\w)/.exec(line)?.[1])
    .filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const typeAddress = async (name) => {
  results.delete('ready');
  await page.click('#address');
  await page.fill('#address', `${siteURL}${name.toLowerCase()}`);
  await page.press('#address', 'Enter');
  return readyIs(name);
};
const focused = () =>
  page.evaluate(() => {
    const node = document.activeElement;
    return `${node?.tagName}#${node?.id}${document.getElementById('pages').contains(node) ? ' in the page' : ''}`;
  });

await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', await readyIs('A'));
for (const name of ['B', 'C', 'D']) check(`page ${name}`, await typeAddress(name));
check('Back is enabled', await waitFor(() => !document.getElementById('back').disabled));

// Right click on Back: the earlier pages, nearest first
await page.locator('canvas[data-bl-view]:visible').click({ position: { x: 300, y: 300 } });
const pageFocus = await focused();
await page.click('#back', { button: 'right' });
check(
  'right click on Back: the earlier pages nearest first and Show full history',
  JSON.stringify(await menuRows()) ===
    JSON.stringify(['Page C', 'Page B', 'Page A', '-', 'Show full history']),
  JSON.stringify(await menuRows()),
);
// Where it is placed (its box moves while it appears)
const placed = await page.evaluate(() => {
  const back = document.getElementById('back').getBoundingClientRect();
  const menu = document.querySelector('.bl-context-menu')?.style;
  return { left: back.left, bottom: back.bottom, menuLeft: menu?.left, menuTop: menu?.top };
});
check(
  'the list opens below the button',
  placed.menuLeft === `${placed.left}px` && placed.menuTop === `${placed.bottom}px`,
  JSON.stringify(placed),
);
check(
  'right press: the page keeps the keyboard',
  pageFocus.endsWith('in the page') && (await focused()) === pageFocus,
  `${pageFocus} -> ${await focused()}`,
);
await page.keyboard.press('Escape');
check('Escape closes the list', !(await menuOpen()));

// Two steps back in one: C is not shown in between
await page.click('#back', { button: 'right' });
results.delete('ready');
const mark = results.logs.length;
await choose('go-2');
check('Page B chosen: B is shown', await readyIs('B'));
check(
  'no page in between is shown',
  JSON.stringify(shownSince(mark)) === '["B"]',
  JSON.stringify(shownSince(mark)),
);
check(
  'the address shows B',
  await waitFor((url) => document.getElementById('address').value.endsWith('/b'), siteURL),
  await page.inputValue('#address'),
);

// Right click on Forward: the later pages, nearest first
check('Forward is enabled', await waitFor(() => !document.getElementById('forward').disabled));
await page.click('#forward', { button: 'right' });
check(
  'right click on Forward: the later pages nearest first',
  JSON.stringify(await menuRows()) ===
    JSON.stringify(['Page C', 'Page D', '-', 'Show full history']),
  JSON.stringify(await menuRows()),
);
results.delete('ready');
await choose('go2');
check('Page D chosen: D comes back', await readyIs('D'));

// A held press opens the list; its release does not go back
await page.hover('#back');
await page.mouse.down();
await sleep(900);
check(
  'held press on Back: the list opens',
  JSON.stringify(await menuRows()) ===
    JSON.stringify(['Page C', 'Page B', 'Page A', '-', 'Show full history']),
  JSON.stringify(await menuRows()),
);
results.delete('ready');
await page.mouse.up();
await sleep(1500);
check(
  'the release of the held press does not go back',
  !results.has('ready'),
  results.get('ready'),
);
check('the list stays open after the release', await menuOpen());
await choose('go-3');
check('Page A chosen from the held list', await readyIs('A'));

// A short click still goes back one step, Enter on the focused button too
check(
  'Forward is enabled after the jump',
  await waitFor(() => !document.getElementById('forward').disabled),
);
results.delete('ready');
await page.click('#forward');
check('a click on Forward goes one step', await readyIs('B'));
await page.focus('#back');
results.delete('ready');
await page.keyboard.press('Enter');
check('Enter on the focused Back goes back', await readyIs('A'));
check('no list after the short click and Enter', !(await menuOpen()));

// view.go beyond the history does nothing (A is the first entry)
const loadsOfA = loads.get('A');
results.delete('ready');
await page.evaluate(() => window.blTest.view().go(-5));
await sleep(1500);
check(
  'go beyond the first entry does nothing',
  !results.has('ready') && loads.get('A') === loadsOfA,
  `${results.get('ready')} ${loadsOfA} -> ${loads.get('A')}`,
);

// Show full history opens the history panel
await page.click('#forward', { button: 'right' });
await choose('show-history');
check(
  'Show full history opens the history panel',
  await waitFor(() => document.getElementById('side-panel')?.dataset.panel === 'history'),
);

// A finger held on Back of the phone layout opens the list; Chrome's own long press contextmenu
// does not open it twice, the lift does not go back
if (chromiumOnly('long press of a finger (CDP Input.dispatchTouchEvent)')) {
  const phone = await browser.newContext({
    viewport: { width: 400, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const tab = await phone.newPage();
  watchErrors(tab);
  const phoneResults = collect(tab);
  await tab.goto(stack.app({ url: `${siteURL}a` }));
  check('phone: first page', (await phoneResults.wait('ready')) === 'A');
  phoneResults.delete('ready');
  await tab.evaluate((url) => window.blTest.load(url), `${siteURL}b`);
  check('phone: second page', (await phoneResults.wait('ready')) === 'B');
  await tab.waitForFunction(() => !document.getElementById('back').disabled, null, {
    timeout: 10000,
  });
  const box = await tab.locator('#back').boundingBox();
  const cdp = await phone.newCDPSession(tab);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  phoneResults.delete('ready');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await sleep(1200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await sleep(1000);
  const rows = await tab.evaluate(() =>
    [...document.querySelectorAll('.bl-context-menu')].map((menu) =>
      [...menu.children].map((node) => (node.tagName === 'HR' ? '-' : node.textContent)),
    ),
  );
  check(
    'phone: a held finger on Back opens one list',
    JSON.stringify(rows) === JSON.stringify([['Page A', '-', 'Show full history']]),
    JSON.stringify(rows),
  );
  check('phone: the lift does not go back', !phoneResults.has('ready'), phoneResults.get('ready'));
  await tab.tap('.bl-context-menu [data-bl-item="go-1"]');
  check('phone: the chosen page is shown', (await phoneResults.wait('ready')) === 'A');
  await phone.close();
}

await browser.close();
finish();
