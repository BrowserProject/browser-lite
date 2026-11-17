// Zoom per site like Chrome: Ctrl + changes the zoom of the host, another host loads at the
// default zoom, back to the host and a new tab of it get its zoom again, Ctrl+0 in one tab resets
// all its tabs, the zoom row of the menu changes it with the mouse alone and puts the demo into
// full screen like Chrome's, and the zoom of the host stays after the demo opens again.
//
//   node tests/demo/zoom-test.mjs [engine-dir]
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

// Every page reports when it shows, also from the back/forward cache
const { url: siteURL } = await serve((req, res) => {
  const name = req.url.slice(1);
  if (!/^[a-z]+$/.test(name)) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>addEventListener('pageshow', () => console.log('RESULT ready=${name}@' + location.hostname))</script>`,
    );
});
// The same server under a second host
const otherURL = siteURL.replace('127.0.0.1', 'localhost');

const stack = await startStack({ app: 'demo', token: 'zoom-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);

const ready = async (expected) => {
  const value = await results.wait('ready', TIMEOUT);
  results.delete('ready');
  return value === expected;
};
// innerWidth of the page in the active tab; the engine runs it after the zoom of the view
const width = async () => {
  results.delete('width');
  await page.evaluate(() => window.blTest.eval('console.log("RESULT width=" + innerWidth)'));
  return Number(await results.wait('width', 10000));
};
const indicator = () =>
  page.evaluate(() => {
    const zoom = document.getElementById('zoom');
    return zoom.hidden ? '' : zoom.textContent;
  });
const indicatorIs = (expected) =>
  page
    .waitForFunction(
      (expected) => {
        const zoom = document.getElementById('zoom');
        return (zoom.hidden ? '' : zoom.textContent) === expected;
      },
      expected,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
const viewZooms = () =>
  page.evaluate(() =>
    window.blTest
      .views()
      .map((view) => view.zoom)
      .join(' '),
  );

await page.goto(stack.app({ url: `${siteURL}one` }));
check('first page', await ready('one@127.0.0.1'));
const base = await width();

// 1) Ctrl + on the first host
await page.keyboard.press('Control+=');
check('Ctrl +: 110 %', await indicatorIs('110 %'), await indicator());
const zoomed = await width();
check('Ctrl +: the page is narrower', zoomed < base, `${zoomed} of ${base}`);

// 2) Another host from the address bar: the default zoom
await page.click('#address');
await page.fill('#address', `${otherURL}two`);
await page.press('#address', 'Enter');
check('other host loads', await ready('two@localhost'));
check('other host: no zoom indicator', await indicatorIs(''), await indicator());
const other = await width();
check('other host: 100 %', other === base, `${other} of ${base}`);

// 3) Back to the first host: its zoom again
await page.click('#back');
check('back to the first host', await ready('one@127.0.0.1'));
check('back: 110 % again', await indicatorIs('110 %'), await indicator());
const back = await width();
check('back: the page is narrower again', back === zoomed, `${back} of ${base}`);

// 4) A new tab of the first host gets its zoom; Ctrl+0 there resets both tabs of the host
await page.evaluate((url) => window.blTest.open(url), `${siteURL}three`);
check('new tab of the first host', await ready('three@127.0.0.1'));
check('new tab: 110 %', await indicatorIs('110 %'), await indicator());
await page.keyboard.press('Control+0');
check('Ctrl+0: no zoom indicator', await indicatorIs(''), await indicator());
check('Ctrl+0: all tabs of the host at 100 %', (await viewZooms()) === '1 1', await viewZooms());

// 5) The zoom row of the menu: minus, the zoom, plus and full screen; the menu stays open for plus
// and minus, full screen closes it
const menuZoom = () =>
  page.evaluate(() => document.querySelector('#side-panel .panel-zoom-level')?.textContent ?? '');
const menuOpen = () => page.evaluate(() => !document.getElementById('side-panel').hidden);
await page.click('#menu-button');
check('menu has a zoom row', (await menuZoom()) === '100 %', await menuZoom());
await page.click('#side-panel [data-item="zoom-in"]');
check('menu plus: 110 %', await indicatorIs('110 %'), await indicator());
check('menu plus: the menu stays open', await menuOpen());
check('menu plus: the row shows 110 %', (await menuZoom()) === '110 %', await menuZoom());
check('menu plus: all tabs of the host', (await viewZooms()) === '1.1 1.1', await viewZooms());
check('menu plus: the page is narrower', (await width()) === zoomed);
await page.click('#side-panel [data-item="zoom-out"]');
await page.click('#side-panel [data-item="zoom-out"]');
check('menu minus twice: 90 %', await indicatorIs('90 %'), await indicator());
check('menu minus: the row shows 90 %', (await menuZoom()) === '90 %', await menuZoom());
await page.click('#side-panel [data-item="zoom-in"]');
check('menu plus: back at 100 %', await indicatorIs(''), await indicator());
// The arrow keys reach the row's buttons; Enter on plus keeps the focus there
const focused = () => page.evaluate(() => document.activeElement?.dataset.item ?? '');
await page.focus('#side-panel [data-item="new-tab"]');
await page.keyboard.press('ArrowUp');
check('ArrowUp from the first item: the last', (await focused()) === 'settings', await focused());
await page.keyboard.press('Home');
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
check('ArrowDown reaches plus', (await focused()) === 'zoom-in', await focused());
await page.keyboard.press('Enter');
check('Enter on plus: 110 %', await indicatorIs('110 %'), await indicator());
check('Enter on plus: the focus stays', (await focused()) === 'zoom-in', await focused());
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
check('Enter on minus: back at 100 %', await indicatorIs(''), await indicator());
const until = (fn) =>
  page.waitForFunction(fn, null, { timeout: 10000 }).then(
    () => true,
    () => false,
  );
await page.click('#side-panel [data-item="fullscreen"]');
check('full screen', await until(() => document.fullscreenElement === document.documentElement));
check('full screen closes the menu', !(await menuOpen()));
await page.click('#menu-button');
const label = await page.getAttribute('#side-panel [data-item="fullscreen"]', 'aria-label');
check('the menu offers to exit full screen', label === 'Exit full screen', label);
await page.click('#side-panel [data-item="fullscreen"]');
check('full screen ends', await until(() => !document.fullscreenElement));
check('the page still shows the zoom of the host', (await width()) === base);

// 6) The zoom of the host stays after the demo opens again
await page.keyboard.press('Control+=');
check('Ctrl + again', await indicatorIs('110 %'), await indicator());
check('both tabs of the host follow', (await viewZooms()) === '1.1 1.1', await viewZooms());
await page.waitForTimeout(500);
await page.goto(stack.app());
check('restored tab loads', await ready('three@127.0.0.1'));
check('restored tab: 110 %', await indicatorIs('110 %'), await indicator());

await browser.close();
finish();
