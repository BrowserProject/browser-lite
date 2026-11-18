// Pinned tabs like Chrome: Pin and Unpin in the tab menu, a pinned tab shows only its icon at the
// left of the strip, a newly pinned tab goes after the pinned ones and an unpinned one right after
// them. Dragging and Ctrl+Shift+PageUp/PageDown keep pinned tabs among themselves and the others
// right of them, new tabs open right of the pinned ones, Duplicate and Reopen closed tab keep the
// pin, Close other tabs and Close tabs to the right leave pinned tabs open. The session keeps the
// pin, and without Restore tabs at start (or with a start page of its own) the pinned tabs still
// come back, in front of the start page.
//
//   node tests/demo/pinned-tabs-test.mjs [engine-dir]
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

// B answers late while slowB is set, so the demo can be left while a restored tab still loads
let slowB = false;
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1).toUpperCase();
  if (!/^[A-F]$/.test(name)) return res.writeHead(404).end();
  const send = () =>
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(
        `<!doctype html><title>${name}</title><p>${name}<script>console.log('RESULT ready=${name}')</script>`,
      );
  if (name === 'B' && slowB) setTimeout(send, 5000);
  else send();
});

const stack = await startStack({ app: 'demo', token: 'pinned-token-0123456789abcdef' });
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
// The titles in strip order, a pinned tab with a leading *
const strip = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab')]
      .map((tab) => `${tab.classList.contains('pinned') ? '*' : ''}${tab.title || 'New tab'}`)
      .join(','),
  );
const stripIs = (expected) =>
  waitFor(
    (expected) =>
      [...document.querySelectorAll('#tab-list .tab')]
        .map((tab) => `${tab.classList.contains('pinned') ? '*' : ''}${tab.title || 'New tab'}`)
        .join(',') === expected,
    expected,
  );
const session = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('bl-session') ?? '{"tabs":[]}')
      .tabs.map((tab) => `${tab.pinned ? '*' : ''}${tab.title}`)
      .join(','),
  );
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active')?.title);
const menuRows = () =>
  page.evaluate(() =>
    [...(document.querySelector('.bl-context-menu')?.children ?? [])].map((node) =>
      node.tagName === 'HR' ? '-' : `${node.textContent}${node.disabled ? ' (off)' : ''}`,
    ),
  );
const tabNamed = (title) => page.locator(`#tab-list .tab[title="${title}"]`);
const rightClick = (title) => tabNamed(title).click({ button: 'right' });
const choose = (item) => page.click(`.bl-context-menu [data-bl-item=${item}]`);
const menu = async (title, item) => {
  await rightClick(title);
  await choose(item);
};
const readyIs = async (name) => {
  for (const end = Date.now() + TIMEOUT; Date.now() < end; ) {
    if (results.get('ready') === name) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
const newTabWith = async (name) => {
  results.delete('ready');
  await page.keyboard.press('Control+t');
  await page.click('#address');
  await page.fill('#address', `${siteURL}${name.toLowerCase()}`);
  await page.press('#address', 'Enter');
  return readyIs(name);
};
// Presses the middle of a tab, moves by dx in steps and releases
async function drag(title, dx) {
  const from = await tabNamed(title).boundingBox();
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + (dx * step) / 10, y);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

await page.goto(stack.app({ url: `${siteURL}a` }));
check('first page', await readyIs('A'));
for (const name of ['B', 'C', 'D']) await newTabWith(name);
check('four tabs', await stripIs('A,B,C,D'), await strip());

// Pin in the menu between Duplicate and Mute tab, like Chrome
await rightClick('C');
const rows = await menuRows();
check(
  'tab menu: Pin after Duplicate',
  rows.slice(rows.indexOf('Duplicate'), rows.indexOf('Duplicate') + 3).join(',') ===
    'Duplicate,Pin,Mute tab',
  JSON.stringify(rows),
);
await choose('pin');
check('Pin: the tab goes to the left', await stripIs('*C,A,B,D'), await strip());
const look = await page.evaluate(() => {
  const tab = document.querySelector('#tab-list .tab.pinned');
  const shown = (selector) => getComputedStyle(tab.querySelector(selector)).display !== 'none';
  return {
    width: tab.getBoundingClientRect().width,
    other: document.querySelector('#tab-list .tab:not(.pinned)').getBoundingClientRect().width,
    title: shown('.title'),
    close: shown('.close'),
    icon: shown('.icon'),
  };
});
check(
  'Pin: only the icon, a small tab',
  look.width <= 60 && look.other > 100 && !look.title && !look.close && look.icon,
  JSON.stringify(look),
);
check('Pin: the session keeps it', (await session()) === '*C,A,B,D', await session());
await rightClick('C');
check(
  'a pinned tab offers Unpin',
  (await menuRows()).includes('Unpin'),
  JSON.stringify(await menuRows()),
);
await page.keyboard.press('Escape');

// A second pinned tab comes after the first
await menu('B', 'pin');
check('Pin: after the pinned tabs', await stripIs('*C,*B,A,D'), await strip());

// Dragging stays within the own part of the strip
await drag('A', -400);
check('drag: a tab does not go before the pinned ones', await stripIs('*C,*B,A,D'), await strip());
await drag('C', 600);
check('drag: a pinned tab stays among the pinned ones', await stripIs('*B,*C,A,D'), await strip());
await tabNamed('A').click();
await page.keyboard.press('Control+Shift+PageUp');
await page.waitForTimeout(300);
check(
  'Ctrl+Shift+PageUp: not into the pinned tabs',
  (await strip()) === '*B,*C,A,D',
  await strip(),
);
await tabNamed('C').click();
await page.keyboard.press('Control+Shift+PageDown');
await page.waitForTimeout(300);
check(
  'Ctrl+Shift+PageDown: a pinned tab stays pinned at the left',
  (await strip()) === '*B,*C,A,D',
  await strip(),
);
await page.keyboard.press('Control+Shift+PageUp');
check('Ctrl+Shift+PageUp: among the pinned tabs', await stripIs('*C,*B,A,D'), await strip());

// New tab to the right of a pinned tab opens right of the pinned ones
await menu('C', 'new-tab-right');
check(
  'New tab to the right of a pinned tab: after them',
  await stripIs('*C,*B,New tab,A,D'),
  await strip(),
);
await page.keyboard.press('Control+w');
check('closed again', await stripIs('*C,*B,A,D'), await strip());

// Duplicate keeps the pin, right after the tab
await menu('C', 'duplicate');
check(
  'Duplicate of a pinned tab: pinned, right after it',
  await stripIs('*C,*C,*B,A,D'),
  await strip(),
);
await page.locator('#tab-list .tab.active .close').evaluate((button) => button.click());
check('the copy closes', await stripIs('*C,*B,A,D'), await strip());

// Close other tabs and Close tabs to the right leave the pinned tabs
await menu('A', 'close-others');
check('Close other tabs: the pinned tabs stay', await stripIs('*C,*B,A'), await strip());
await page.keyboard.press('Control+Shift+t');
check('the closed tab comes back', await stripIs('*C,*B,A,D'), await strip());
await menu('C', 'close-right');
check(
  'Close tabs to the right of a pinned tab: only the others go',
  await stripIs('*C,*B'),
  await strip(),
);
await rightClick('B');
const pinnedOnly = await menuRows();
check(
  'only pinned tabs: Close other tabs and Close tabs to the right are off',
  pinnedOnly.includes('Close other tabs (off)') &&
    pinnedOnly.includes('Close tabs to the right (off)'),
  JSON.stringify(pinnedOnly),
);
await page.keyboard.press('Escape');
await page.keyboard.press('Control+Shift+t');
await page.keyboard.press('Control+Shift+t');
check('both come back', await stripIs('*C,*B,A,D'), await strip());

// Reopen closed tab brings a pinned tab back pinned at its place
await menu('B', 'close');
check('a pinned tab closes', await stripIs('*C,A,D'), await strip());
await page.keyboard.press('Control+Shift+t');
check('Reopen closed tab: pinned again', await stripIs('*C,*B,A,D'), await strip());

// Unpin: right after the pinned tabs
await menu('C', 'pin');
check('Unpin: right after the pinned tabs', await stripIs('*B,C,A,D'), await strip());
await menu('C', 'pin');
check('pinned again', await stripIs('*B,*C,A,D'), await strip());

// The session brings the pinned tabs back pinned
await page.waitForTimeout(500);
check('session', (await session()) === '*B,*C,A,D', await session());
slowB = true;
await page.goto(stack.app());
check('opened again: pinned tabs restored pinned', await stripIs('*B,*C,A,D'), await strip());
check('B is in front', (await activeTitle()) === 'B', await activeTitle());

// Like Chrome the pinned tabs also come back without Restore tabs at start, and with a start page.
// The demo is left while B still loads its page: the session keeps it
await page.evaluate(async () => {
  const { profile } = window.blTest;
  profile.savePrefs('settings', { ...profile.prefs('settings'), restoreSession: false });
  await profile.prefsSaved();
});
results.delete('ready');
await page.goto(stack.app({ url: `${siteURL}e` }));
slowB = false;
check('start page loads', await readyIs('E'));
check('a start page of its own: after the pinned tabs', await stripIs('*B,*C,E'), await strip());
check('the start page is in front', (await activeTitle()) === 'E', await activeTitle());
await page.waitForTimeout(500);
await page.goto(stack.app());
check(
  'without Restore tabs at start: the pinned tabs and the start page',
  await waitFor(() => {
    const tabs = [...document.querySelectorAll('#tab-list .tab')];
    return (
      tabs.length === 3 &&
      tabs[0].title === 'B' &&
      tabs[1].title === 'C' &&
      tabs.slice(0, 2).every((tab) => tab.classList.contains('pinned')) &&
      !tabs[2].classList.contains('pinned') &&
      tabs[2].classList.contains('active')
    );
  }),
  await strip(),
);

await browser.close();
finish();
