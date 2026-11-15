// Paint holding like Chrome and Safari: from the commit of a new page the view keeps showing the
// page left until the new one is visually non-empty, its load ends or 4 s passed. Before, every
// navigation showed a white view from the commit until the first paint of the new page: here page
// B waits for a render-blocking stylesheet, and the view was white the whole time. With and
// without the compositor: a new page that waits for its stylesheet keeps the old one in view and
// shows itself once the stylesheet arrives; a new page that never gets there shows after the
// limit; an almost empty page shows at the end of its load; back from the back/forward cache
// shows the cached page.
//
//   node tests/core/paint-holding-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  finish,
  launch,
  near,
  openHost,
  serve,
  shownPixel,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const YELLOW = [255, 204, 0];
const BLUE = [0, 204, 255];
const GREEN = [0, 255, 0];
const WHITE = [255, 255, 255];

const pages = {
  '/a': '<!doctype html><body style="background:#fc0;font:40px sans-serif"><h1>Page A</h1>',
  '/b': '<!doctype html><link rel=stylesheet href="/slow.css"><body><h1>Page B</h1>',
  '/never': '<!doctype html><link rel=stylesheet href="/never.css"><body><h1>Never</h1>',
  '/empty': '<!doctype html><body style="background:#0f0">',
};
// Stylesheets that answer when the test lets them (the path is the key)
const held = new Map();
const requested = new Set();
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const html = pages[path];
  if (html) {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(html);
    return;
  }
  if (path.endsWith('.css')) {
    requested.add(path);
    held.set(path, () =>
      res
        .writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' })
        .end('body { background: #0cf }'),
    );
    return;
  }
  res.writeHead(404).end();
});
const at = (path) => `${siteURL}${path.slice(1)}`;
function release(path) {
  held.get(path)?.();
  held.delete(path);
}

const stack = await startStack({ token: 'paint-holding-token-0123456789ab', allowLocal: true });
const browser = await launch();

const pixel = (tab) => shownPixel(tab, 200, 150);
const shows = (tab, color, ms = 20000) => waitFor(async () => near(await pixel(tab), color), ms);

// The colours the view shows every 250 ms for ms
async function sample(tab, ms) {
  const seen = [];
  for (const end = Date.now() + ms; Date.now() < end; ) {
    seen.push(await pixel(tab));
    await tab.waitForTimeout(250);
  }
  return seen;
}
const allNear = (seen, color) => seen.length > 0 && seen.every((p) => near(p, color));

async function navigate(tab, path) {
  requested.clear();
  await tab.evaluate(
    (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
    at(path),
  );
}

async function run(label, params) {
  const tab = await browser.newPage({ viewport: { width: 800, height: 600 } });
  check(`${label}: host page starts`, await openHost(tab, stack.app({ url: at('/a'), ...params })));
  check(`${label}: page A shows`, await shows(tab, YELLOW));

  // B commits and waits for its stylesheet: A stays in view
  await navigate(tab, '/b');
  check(
    `${label}: page B asks for its stylesheet`,
    await waitFor(() => requested.has('/slow.css')),
  );
  const whileHeld = await sample(tab, 1500);
  check(
    `${label}: page A stays in view while page B waits for its stylesheet`,
    allNear(whileHeld, YELLOW),
    JSON.stringify(whileHeld),
  );
  release('/slow.css');
  check(`${label}: page B shows once its stylesheet arrived`, await shows(tab, BLUE, 10000));

  // A stylesheet that never comes: the new page shows after the limit of 4 s
  await navigate(tab, '/never');
  check(
    `${label}: the waiting page asks for its stylesheet`,
    await waitFor(() => requested.has('/never.css')),
  );
  const start = Date.now();
  check(`${label}: page B stays in view first`, near(await pixel(tab), BLUE));
  const shown = await shows(tab, WHITE, 10000);
  const after = (Date.now() - start) / 1000;
  check(
    `${label}: a page that waits for good shows after the limit`,
    shown && after > 2.5,
    `${after.toFixed(1)} s`,
  );
  release('/never.css');

  // A page with nothing to count as content shows at the end of its load
  const emptyStart = Date.now();
  await navigate(tab, '/empty');
  check(`${label}: an almost empty page shows when loaded`, await shows(tab, GREEN, 3000));
  const emptyAfter = (Date.now() - emptyStart) / 1000;
  check(`${label}: ...without waiting for the limit`, emptyAfter < 3, `${emptyAfter} s`);

  // Back from the back/forward cache: the cached page right away
  await tab.evaluate(() => window.blTest.eval('history.back()'));
  check(`${label}: back shows the cached page`, await shows(tab, BLUE, 3000));
  await tab.close();
}

await run('compositor', {});
await run('without compositor', { compositing: '0' });

await browser.close();
for (const path of [...held.keys()]) release(path);
finish();
