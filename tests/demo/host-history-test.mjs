// The back and forward of the host browser (its buttons, the iOS edge swipe, the Android back
// gesture) act on the tab in front like in an in-app browser: back goes back in the tab while it
// has a back entry, only then the host leaves the demo; forward after a back goes forward in it.
// The demo adds its host entry in the first user action, not when the tab gets a back entry:
// Safari's back skips an entry pushed more than 10 s after one (no test browser applies that
// rule), so here the tab gets its back entries by script.
//
//   node tests/demo/host-history-test.mjs [engine-dir]
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

const { url: siteURL } = await serve((req, res) => {
  const n = /^\/p([1-3])$/.exec(req.url)?.[1];
  if (!n) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><title>P${n}</title><p>P${n}<script>console.log('RESULT ready=${n}')</script>`,
    );
});

const stack = await startStack({ app: 'demo', token: 'hostback-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

const tabAt = (n) =>
  page
    .waitForFunction((n) => window.blTest?.view()?.url.endsWith(`/p${n}`), n, { timeout: 30000 })
    .then(
      () => true,
      () => false,
    );
const hostAt = (place) =>
  page
    .waitForFunction((place) => history.state?.blHost === place, place, { timeout: 10000 })
    .then(
      () => true,
      () => false,
    );
const tabURL = () => page.evaluate(() => window.blTest?.view()?.url);
const hostBack = () => page.goBack({ waitUntil: 'commit' }).catch(() => {});
const hostForward = () => page.goForward({ waitUntil: 'commit' }).catch(() => {});

// The host tab had a page before the demo
await page.goto('about:blank#before');
await page.goto(stack.app({ url: `${siteURL}p1` }));
check('first page', (await results.wait('ready', TIMEOUT)) === '1');
check('no back in the tab: the host stays on its entry', await hostAt('base'));

// A user action, then navigations by script
const before = await page.evaluate(() => history.length);
await page.click('#address');
await page.press('#address', 'Escape');
check('a user action without back in the tab: the host stays on its entry', await hostAt('base'));
const length = await page.evaluate(() => history.length);
check('the user action adds the host entry', length === before + 1, `${before} -> ${length}`);
results.delete('ready');
await page.evaluate(
  (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
  `${siteURL}p2`,
);
check('second page', (await results.wait('ready')) === '2');
check('back in the tab: the host goes to the entry above', await hostAt('guard'));
results.delete('ready');
await page.evaluate(
  (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
  `${siteURL}p3`,
);
check('third page', (await results.wait('ready')) === '3');
check(
  'back entries in the tab: no new host entries',
  (await page.evaluate(() => history.length)) === length,
);

await hostBack();
check('host back: the tab goes back', await tabAt(2), await tabURL());
check('host back: the demo stays', page.url().startsWith(stack.origin), page.url());
check('host back: ready for the next back', await hostAt('guard'));
await hostBack();
check('second host back: the tab goes back again', await tabAt(1), await tabURL());
check('first entry of the tab: the host on its own entry', await hostAt('base'));

await hostForward();
check('host forward: the tab goes forward', await tabAt(2), await tabURL());
await hostBack();
check('host back after forward', await tabAt(1), await tabURL());
await hostAt('base');

await hostBack();
await page.waitForURL(/^about:blank/, { timeout: 10000 }).catch(() => {});
check(
  'host back without a back entry in the tab: leaves the demo',
  page.url() === 'about:blank#before',
  page.url(),
);

await browser.close();
finish();
