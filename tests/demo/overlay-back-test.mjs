// The back of a phone (Android back key or gesture, Safari's back) with a menu, sheet or popup open
// closes it and leaves the tab where it is, like Chrome on Android and Safari: the menu sheet, the
// tab overview, the link context menu after a long press and the list of a <select>. The demo sees
// that back as its host history moving back. Without a back entry in the tab the host still keeps
// an entry while an overlay is open, so that back closes the overlay instead of leaving the demo;
// the next one leaves. A panel beside the page in the desktop layout is no overlay: back goes back
// in the tab and the panel stays.
//
//   node tests/demo/overlay-back-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  emulateTouchPoints,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const BODY =
  '<a href="/elsewhere" style="display:block;height:150px;background:#cfc">link</a>' +
  '<select style="display:block;margin:20px;font-size:20px"><option>One<option>Two</select>';
const { url: siteURL } = await serve((req, res) => {
  const n = /^\/p([1-3])$/.exec(req.url)?.[1];
  if (!n) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>P${n}</title><style>body{margin:0}</style>${BODY}<p>P${n}<script>console.log('RESULT ready=${n}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'overlayback-token-0123456789abcd' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  reducedMotion: 'reduce',
});
await emulateTouchPoints(context);
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
// The long press for the context menu, by touch events of CDP
const cdp = BROWSER === 'chromium' ? await context.newCDPSession(page) : null;

const tabURL = () => page.evaluate(() => window.blTest?.view()?.url ?? '');
// fn is a function or the text of an expression, evaluated in the page
const until = (fn, arg, timeout = 10000) =>
  page.waitForFunction(fn, arg, { timeout }).then(
    () => true,
    () => false,
  );
const hostAt = (place) => until((place) => history.state?.blHost === place, place);
const hostBack = () => page.goBack({ waitUntil: 'commit' }).catch(() => {});
async function nav(n) {
  results.delete('ready');
  await page.evaluate(
    (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
    `${siteURL}p${n}`,
  );
  return (await results.wait('ready')) === String(n);
}

/** Opens an overlay, gives a host back and checks that it closed and the tab stayed. */
async function backCloses(name, open, isOpen) {
  const url = await tabURL();
  await open();
  check(`${name}: open`, await until(isOpen));
  await hostBack();
  check(`${name}: back closes it`, await until(`!(${isOpen})`));
  // Time for a wrong traversal of the tab to show
  await page.waitForTimeout(1000);
  check(
    `${name}: back leaves the tab where it was`,
    (await tabURL()) === url,
    `${url} -> ${await tabURL()}`,
  );
  check(`${name}: the demo stays`, page.url().startsWith(stack.origin), page.url());
}

// Whether an overlay is open, as expressions
const menuOpen = `document.getElementById('menu-button').getAttribute('aria-expanded') === 'true'`;
const overviewOpen = `!document.getElementById('tab-overview').hidden`;
const contextMenuOpen = `!!document.querySelector('.bl-context-menu')`;
const selectOpen = `!!document.querySelector('.bl-select-popup')`;

await page.goto('about:blank#before');
await page.goto(stack.app({ url: `${siteURL}p1` }));
check('first page', (await results.wait('ready', TIMEOUT)) === '1');
// The first user action adds the host entry
await page.tap('#address');
await page.keyboard.press('Escape');
check('second page', await nav(2));
check('third page', await nav(3));
check('back in the tab: the host on the entry above', await hostAt('guard'));

await backCloses('menu', () => page.tap('#menu-button'), menuOpen);
await hostAt('guard');
await backCloses('tab overview', () => page.tap('#tab-count'), overviewOpen);
await hostAt('guard');
const origin = await canvasOrigin(page);
if (chromiumOnly('link context menu after a long press')) {
  await backCloses(
    'link context menu',
    async () => {
      const point = { x: origin.x + 100, y: origin.y + 75 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(1000);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    contextMenuOpen,
  );
  await hostAt('guard');
}
await backCloses(
  'select list',
  () => page.touchscreen.tap(origin.x + 60, origin.y + 190),
  selectOpen,
);
await hostAt('guard');

await hostBack();
check(
  'back without an overlay: the tab goes back',
  await until(() => window.blTest?.view()?.url.endsWith('/p2'), null, 30000),
  await tabURL(),
);
await hostAt('guard');
await hostBack();
check(
  'back again: the first page',
  await until(() => window.blTest?.view()?.url.endsWith('/p1'), null, 30000),
  await tabURL(),
);
check('no back entry in the tab: the host on its own entry', await hostAt('base'));

// Nothing to go back to in the tab: the open menu still takes the back
await page.tap('#menu-button');
check('menu without a back entry: the host keeps an entry for back', await hostAt('guard'));
await hostBack();
check('menu without a back entry: back closes it', await until(`!(${menuOpen})`));
check('menu without a back entry: the demo stays', page.url().startsWith(stack.origin), page.url());
check('menu closed: the host on its own entry again', await hostAt('base'));
await hostBack();
await page.waitForURL(/^about:blank/, { timeout: 10000 }).catch(() => {});
check('then back leaves the demo', page.url() === 'about:blank#before', page.url());

// The desktop layout: the history panel beside the page stays, back goes back in the tab
const desktop = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const wide = await desktop.newPage();
watchErrors(wide);
const wideResults = collect(wide);
await wide.goto(stack.app({ url: `${siteURL}p1` }));
check('desktop: first page', (await wideResults.wait('ready', TIMEOUT)) === '1');
await wide.click('#address');
await wide.press('#address', 'Escape');
wideResults.delete('ready');
await wide.evaluate(
  (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
  `${siteURL}p2`,
);
check('desktop: second page', (await wideResults.wait('ready')) === '2');
await wide.waitForFunction(() => history.state?.blHost === 'guard');
await wide.keyboard.press('Control+h');
const historyOpen = () => document.getElementById('side-panel').dataset.panel === 'history';
check('desktop: history panel open', await wide.waitForFunction(historyOpen).then(() => true));
await wide.goBack({ waitUntil: 'commit' }).catch(() => {});
check(
  'desktop: back with the panel beside the page goes back in the tab',
  await waitFor(
    async () => (await wide.evaluate(() => window.blTest?.view()?.url ?? '')).endsWith('/p1'),
    30000,
  ),
);
check('desktop: the history panel stays', await wide.evaluate(historyOpen));

await browser.close();
finish();
