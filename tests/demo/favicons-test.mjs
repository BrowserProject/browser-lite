// Remembered favicons per page like Chrome's favicon database: pages of one host with different
// icons show their own in the history panel and in the restored background tabs, a page without
// an icon shows the globe, an address a page set with history.pushState gets the icon of its
// document, a changed icon replaces the old one at once, a tab shows the remembered icon of a page
// it goes to again until the engine reports one (not the icon of the last page of the host), and
// removing the last visit of a page from the history forgets its icon.
//
//   node tests/demo/favicons-test.mjs [engine-dir]
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

timeLimit(TIMEOUT * 4);

const svg = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`;
const ready = (name) => `<script>console.log('RESULT ready=${name}')</script>`;
let changing = '#ff0';
// Answers of /held after the first that stop before the head ends (a slow network)
const held = [];
let heldVisits = 0;
const { url: siteURL } = await serve((req, res) => {
  const html = (body) =>
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(`<!doctype html>${body}`);
  const image = (color) =>
    res
      .writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
      .end(svg(color));
  if (req.url === '/red.svg') return image('#f00');
  if (req.url === '/blue.svg') return image('#00f');
  if (req.url === '/changing.svg') return image(changing);
  if (req.url === '/a')
    return html(`<title>A</title><link rel="icon" href="/red.svg">${ready('a')}`);
  if (req.url === '/b')
    return html(`<title>B</title><link rel="icon" href="/blue.svg">${ready('b')}`);
  // No link and /favicon.ico is a 404: no icon
  if (req.url === '/c') return html(`<title>C</title><p>C${ready('c')}`);
  // A green data: icon, then a new address of the same document once the icon is there
  if (req.url === '/app')
    return html(
      `<title>App</title><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg('#0f0'))}"><script>setTimeout(() => { history.pushState(null, '', '/app/x'); console.log('RESULT ready=app'); }, 1500)</script>`,
    );
  if (req.url === '/held') {
    if (heldVisits++ === 0)
      return html(`<title>Held</title><link rel="icon" href="/red.svg">${ready('held')}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write(`<!doctype html><title>Held</title>${ready('held')}`);
    return held.push(res);
  }
  if (req.url === '/changing')
    return html(
      `<title>Changing</title><link rel="icon" href="/changing.svg">${ready('changing')}`,
    );
  res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'favicons-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

async function go(name) {
  results.delete('ready');
  await page.click('#address');
  await page.fill('#address', `${siteURL}${name}`);
  await page.press('#address', 'Enter');
  await results.wait('ready', TIMEOUT);
  check(`page ${name} loaded`, results.get('ready') === name.split('/')[0], results.get('ready'));
}
/** The remembered icon of `path` once it is stored (with `differentFrom`: once it changed). */
const stored = (path, differentFrom = null) =>
  page
    .waitForFunction(
      ({ url, differentFrom }) => {
        const store = JSON.parse(localStorage.getItem('bl-favicons') ?? '{}');
        const ref = store.pages?.[url];
        if (!ref) return null;
        const data = ref.icon ? store.icons[ref.icon] : 'none';
        return data !== differentFrom && data;
      },
      { url: `${siteURL}${path}`, differentFrom },
      { timeout: 10000 },
    )
    .then(
      (handle) => handle.jsonValue(),
      () => null,
    );
/** The colour of an icon element: the centre pixel of an image as r,g,b, 'globe' or 'none'. */
const colors = (selector) =>
  page.evaluate(async (selector) => {
    const result = [];
    for (const slot of document.querySelectorAll(selector)) {
      const img = slot.querySelector('img');
      if (!img) {
        result.push(slot.querySelector('svg') ? 'globe' : 'none');
        continue;
      }
      const image = new Image();
      image.src = img.src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, 32, 32);
      result.push([...context.getImageData(16, 16, 1, 1).data].slice(0, 3).join(','));
    }
    return result;
  }, selector);
/** Path of every history row with the colour of its icon. */
async function historyIcons() {
  await page.keyboard.press('Control+h');
  await page.waitForSelector('#side-panel .panel-row');
  const paths = await page.evaluate(() =>
    [...document.querySelectorAll('#side-panel .panel-row')].map((row) =>
      new URL(
        `http://${row.querySelector('.panel-url').textContent.replace(/^https?:\/\//, '')}`,
      ).pathname.slice(1),
    ),
  );
  const shown = await colors('#side-panel .panel-row .panel-link');
  await page.keyboard.press('Escape');
  return Object.fromEntries(paths.map((path, i) => [path, shown[i]]));
}
const RED = '255,0,0';
const BLUE = '0,0,255';
const GREEN = '0,255,0';
const YELLOW = '255,255,0';
const MAGENTA = '255,0,255';

// Tab 1: A then B; tab 2: C; tab 3: the app, then the changing icon
await page.goto(stack.app({ url: `${siteURL}a` }));
await results.wait('ready', TIMEOUT);
await go('b');
// Tab 1 again: the red page, the blue one and the red page whose head does not arrive
await go('held');
check('the icon of /held is stored', Boolean(await stored('held')));
await go('b');
await go('held');
const activeIcon = async () => (await colors('#tab-list .tab.active .icon'))[0];
await page.waitForTimeout(1000);
check(
  'a page seen before: its remembered icon before its head',
  (await activeIcon()) === RED,
  await activeIcon(),
);
await go('b');
for (const res of held.splice(0)) res.end();
await page.keyboard.press('Control+t');
await go('c');
await page.keyboard.press('Control+t');
await go('app');
await go('changing');
for (const path of ['a', 'b', 'c', 'app', 'app/x', 'changing'])
  check(`the icon of /${path} is stored`, Boolean(await stored(path)));

const before = await historyIcons();
check(
  'history: every page of the host shows its own icon',
  before.a === RED &&
    before.b === BLUE &&
    before.c === 'globe' &&
    before.app === GREEN &&
    before['app/x'] === GREEN &&
    before.changing === YELLOW,
  JSON.stringify(before),
);

// The site changes its icon: the next visit replaces the remembered one
changing = '#f0f';
const yellow = await stored('changing');
await page.keyboard.press('Control+t');
await go('changing');
check('a changed icon is stored at once', Boolean(await stored('changing', yellow)));
const after = await historyIcons();
check('history: the changed icon', after.changing === MAGENTA, JSON.stringify(after));

// Opening the demo again: the background tabs show the icons of their pages until they load
await page.waitForTimeout(500);
results.delete('ready');
await page.goto(stack.app());
await results.wait('ready', TIMEOUT);
const restored = async () => (await colors('#tab-list .tab:not(.active) .icon')).join(' ');
const expected = [BLUE, 'globe', MAGENTA].join(' ');
const restoredShown = await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#tab-list .tab:not(.active) .icon')].every(
        (slot) => slot.querySelector('svg') || slot.querySelector('img')?.naturalWidth,
      ),
    null,
    { timeout: 10000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'session: the restored background tabs show the icons of their pages',
  restoredShown && (await restored()) === expected,
  await restored(),
);

// Removing the only visit of A forgets its icon, B keeps its own
await page.keyboard.press('Control+h');
await page.locator('#side-panel .panel-row[title$="/a"] .panel-remove').click();
await page.keyboard.press('Escape');
const pages = await page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem('bl-favicons') ?? '{}').pages ?? {}),
);
check(
  'removed from the history: the icon of the page goes',
  !pages.includes(`${siteURL}a`) && pages.includes(`${siteURL}b`),
  JSON.stringify(pages),
);

await browser.close();
finish();
