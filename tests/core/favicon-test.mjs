// The favicon belongs to the page: the engine reports it (icon event) for every page that loaded,
// also when the last page had the same icon (after a page without an icon, after back to a page
// after a page that never loaded), and loads an icon address only once per view. An icon
// that arrives after the page was left is not reported for the next page. Like Chrome the icon of
// a <link rel=icon> comes once the head is parsed, not only after the load event, follows changes
// of the links after the load (a new address, a data: icon, no link left: /favicon.ico, an icon
// of a few before without a new request), and data: icons work.
//
//   node tests/core/favicon-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
  evalPage,
  finish,
  hostEvents,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

// The size tells the icons apart in the events (icon-image:WxH)
const svg = (size, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`;
const ICON = svg(16, '#e00000');
const dataIcon = (size) => `data:image/svg+xml,${encodeURIComponent(svg(size, '#00a000'))}`;
const page = (title, icon) =>
  `<!doctype html><html><head><title>${title}</title><link rel="icon" href="${icon}"></head><body><p>${title}</p></body></html>`;
const iconRequests = [];
// Responses of /hang that are still open (a page that commits but never loads)
const hanging = [];
// The image of /early, answered when the test says so
const heldImages = [];
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, siteURL).pathname;
  if (path.endsWith('.svg')) {
    iconRequests.push(path);
    const send = () => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(ICON);
    if (path === '/slow-icon.svg') setTimeout(send, 3000);
    else if (path === '/early.svg')
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg(18, '#e0e000'));
    else if (path === '/blue.svg')
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg(24, '#0000e0'));
    else send();
    return;
  }
  if (path === '/favicon.ico') {
    iconRequests.push(path);
    return res.writeHead(404).end();
  }
  if (path === '/held.png') return heldImages.push(res);
  const html = { 'Content-Type': 'text/html; charset=utf-8' };
  if (path === '/a') return res.writeHead(200, html).end(page('A', '/icon.svg'));
  if (path === '/b') return res.writeHead(200, html).end(page('B', '/icon.svg'));
  if (path === '/slow') return res.writeHead(200, html).end(page('SLOW', '/slow-icon.svg'));
  if (path === '/early')
    return res
      .writeHead(200, html)
      .end(
        `<!doctype html><title>EARLY</title><link rel="icon" href="/early.svg"><p>early<img src="/held.png">`,
      );
  if (path === '/data') return res.writeHead(200, html).end(page('DATA ICON', dataIcon(20)));
  if (path === '/change')
    return res
      .writeHead(200, html)
      .end(
        `<!doctype html><title>CHANGE</title><link id="ic" rel="icon" href="/icon.svg"><p>change`,
      );
  if (path === '/hang') {
    hanging.push(res);
    res.writeHead(200, html).write(`<!doctype html><title>HANG</title><p>${' '.repeat(2048)}`);
    return;
  }
  res.writeHead(404).end();
});

const browser = await launch({ args: SWIFTSHADER });
const stack = await startStack();
const tab = await browser.newPage({ viewport: { width: 800, height: 500 } });
check('host page started a browser', await openHost(tab, stack.app({ url: `${siteURL}a` })));

const title = () => tab.evaluate(() => window.blTest.view()?.title ?? '');
const waitTitle = (expected, ms = 30000) => waitFor(async () => (await title()) === expected, ms);
const count = async (match) => (await hostEvents(tab)).filter((e) => match.test(e)).length;
const icons = () => count(/^icon-image:16x16$/);
const loads = () => count(/^load$/);
// Until the n-th icon arrived
const iconCount = (n, ms = 20000) => waitFor(async () => (await icons()) >= n, ms);

check('page A loaded', await waitTitle('A', 60000));
check('icon of page A', await iconCount(1), String(await icons()));

// A page without an icon (data:), then a page of the site with the same icon address
await load(tab, 'data:text/html,<title>DATA</title><p>hello');
check('page without an icon loaded', await waitTitle('DATA'));
await load(tab, `${siteURL}b`);
check('page B loaded', await waitTitle('B'));
check(
  'icon of page B, the same address as the icon of A',
  await iconCount(2),
  String(await icons()),
);
check(
  'the icon address was loaded once',
  iconRequests.filter((path) => path === '/icon.svg').length === 1,
  iconRequests.join(),
);

// A page that commits but never loads (another site in a tab strip), then back to B
await load(tab, `${siteURL}hang`);
check('page that never loads committed', await waitTitle('HANG'));
await tab.evaluate(() => window.blTest.view().back());
check('back on page B', await waitTitle('B'));
check('icon of page B after back', await iconCount(3), String(await icons()));
for (const res of hanging.splice(0)) res.end();

// An icon that arrives after the page was left is not the icon of the next page
const before = await loads();
await load(tab, `${siteURL}slow`);
check('slow icon page loaded', await waitTitle('SLOW'));
await waitFor(async () => (await loads()) > before, 20000);
await waitFor(() => iconRequests.includes('/slow-icon.svg'), 10000);
await load(tab, 'data:text/html,<title>LEFT</title><p>left');
check('left the page before its icon arrived', await waitTitle('LEFT'));
await tab.waitForTimeout(5000);
check('no icon for the next page', (await icons()) === 3, String(await icons()));

const sized = (size) => count(new RegExp(`^icon-image:${size}x${size}$`));

// The icon of a page whose load event waits for an image: once the head is parsed
const earlyLoads = await loads();
await load(tab, `${siteURL}early`);
check('page with a held image committed', await waitTitle('EARLY'));
check('its icon', await waitFor(async () => (await sized(18)) === 1, 20000));
check('before the load event', (await loads()) === earlyLoads);
for (const res of heldImages.splice(0)) res.writeHead(404).end();
check(
  'the page loads once the image is answered',
  await waitFor(async () => (await loads()) > earlyLoads, 20000),
);
await tab.waitForTimeout(1000);
check('no icon again at the load event', (await sized(18)) === 1, String(await sized(18)));

// A data: icon
await load(tab, `${siteURL}data`);
check('page with a data: icon loaded', await waitTitle('DATA ICON'));
check(
  'the data: icon',
  await waitFor(async () => (await sized(20)) === 1, 20000),
  String(await sized(20)),
);

// Icon links a script changes after the load
const changeLoads = await loads();
await load(tab, `${siteURL}change`);
check('page that changes its icon loaded', await waitTitle('CHANGE'));
await waitFor(async () => (await loads()) > changeLoads, 20000);
check('its first icon', await iconCount(4), String(await icons()));
await evalPage(tab, `document.getElementById('ic').href = '/blue.svg'`);
check(
  'the new icon address',
  await waitFor(async () => (await sized(24)) === 1, 20000),
  String(await sized(24)),
);
await evalPage(tab, `document.getElementById('ic').href = ${JSON.stringify(dataIcon(20))}`);
check(
  'a data: icon set by a script',
  await waitFor(async () => (await sized(20)) === 2, 20000),
  String(await sized(20)),
);
const emptyIcons = await count(/^icon:0$/);
await evalPage(tab, `document.getElementById('ic').remove()`);
check(
  'no icon link left: /favicon.ico (not there: no icon)',
  await waitFor(async () => (await count(/^icon:0$/)) > emptyIcons, 20000),
  iconRequests.join(),
);
await evalPage(
  tab,
  `document.head.insertAdjacentHTML('beforeend', '<link rel="icon" href="/blue.svg">')`,
);
check(
  'an icon of a few before comes again (an unread badge)',
  await waitFor(async () => (await sized(24)) === 2, 20000),
  String(await sized(24)),
);
check(
  'without a new request',
  iconRequests.filter((path) => path === '/blue.svg').length === 1,
  iconRequests.join(),
);
check(
  '/favicon.ico asked once',
  iconRequests.filter((path) => path === '/favicon.ico').length === 1,
  iconRequests.join(),
);

await browser.close();
finish();
