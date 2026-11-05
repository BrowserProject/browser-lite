// The favicon belongs to the page: the engine reports it (icon event) for every page that loaded,
// also when the last page had the same icon (after a page without an icon, after back to a page
// after a page that never loaded), and loads an icon address only once per view. An icon
// that arrives after the page was left is not reported for the next page.
//
//   node tests/core/favicon-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
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

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#e00000"/></svg>';
const page = (title, icon) =>
  `<!doctype html><html><head><title>${title}</title><link rel="icon" href="${icon}"></head><body><p>${title}</p></body></html>`;
const iconRequests = [];
// Responses of /hang that are still open (a page that commits but never loads)
const hanging = [];
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, siteURL).pathname;
  if (path.endsWith('.svg')) {
    iconRequests.push(path);
    const send = () => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(ICON);
    if (path === '/slow-icon.svg') setTimeout(send, 3000);
    else send();
    return;
  }
  const html = { 'Content-Type': 'text/html; charset=utf-8' };
  if (path === '/a') return res.writeHead(200, html).end(page('A', '/icon.svg'));
  if (path === '/b') return res.writeHead(200, html).end(page('B', '/icon.svg'));
  if (path === '/slow') return res.writeHead(200, html).end(page('SLOW', '/slow-icon.svg'));
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

await browser.close();
finish();
