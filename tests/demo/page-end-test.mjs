// The demo page ended from outside (apps/demo/src/main.ts, reload.ts watchUnexpectedEnd):
// - the host browser ends the page and loads it again, as iOS does with a page that uses too
//   much memory (here a reload whose pagehide leaves the demo's running mark): the tabs come back, also when
//   the address has ?url= (before only that tab came back); a second end within a minute starts
//   safe (the tabs load only when clicked)
// - back from the back-forward cache, where the core ended the engine at pagehide: the demo
//   starts a new one with its tabs
//
//   node tests/demo/page-end-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(
      `<!doctype html><title>${name}</title><p>${name}<script>console.log("RESULT loaded=${name}")</script>`,
    );
});
const stack = await startStack({ app: 'demo', token: 'page-end-token-0123456789abcd' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
watchErrors(page);
const loaded = [];
page.on('console', (message) => {
  const match = /RESULT loaded=(\w+)/.exec(message.text());
  if (match) loaded.push(match[1]);
});
const waitLoaded = async (name, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) {
    const index = loaded.indexOf(name);
    if (index >= 0) {
      loaded.splice(index, 1);
      return true;
    }
  }
  return false;
};
const started = () =>
  page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const titles = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent),
  );
const notice = () => page.evaluate(() => document.body.innerText);

await page.goto(stack.app({ url: `${siteURL}one` }));
await started();
await waitLoaded('one');
await page.click('#new-tab');
await page.fill('#address', `${siteURL}two`);
await page.press('#address', 'Enter');
await waitLoaded('two');
await page.waitForTimeout(1500);

// The page ends without pagehide and loads again at the same address (with ?url=), like after
// iOS ended it: a listener after the demo's own sets its running mark again in pagehide
const crash = async () => {
  await page.evaluate(() =>
    addEventListener('pagehide', () => sessionStorage.setItem('bl-running', '1')),
  );
  await page.reload({ timeout: TIMEOUT });
  await started();
};
await crash();
const first = await titles();
check(
  'after the page was ended both tabs are back, not only the one of ?url=',
  first.length === 2 && first.includes('one') && first.includes('two'),
  first.join(', '),
);
check('the tab in front loads', await waitLoaded('two'));
check('the address has no ?url= any more', !page.url().includes('url='), page.url());

await page.waitForTimeout(1500);
await crash();
const second = await titles();
check(
  'ended again within a minute: the tabs are back',
  second.includes('one') && second.includes('two'),
  second.join(', '),
);
check('and load only when clicked', (await notice()).includes('load only when clicked'));

// Back from the back-forward cache: the core ended the engine at pagehide
await page.evaluate(() =>
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
);
check(
  'pagehide into the back-forward cache ends the engine',
  await page.evaluate(
    () => window.blTest.browser === null || window.blTest.browser.state === 'destroyed',
  ),
);
loaded.length = 0;
await page.evaluate(() =>
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
);
await page
  .waitForFunction(() => window.blTest.browser?.state === 'ready', null, { timeout: 30000 })
  .catch(async () => console.log('   ', await notice()));
await started();
const restored = await titles();
check(
  'shown again from the cache, a new engine runs the tabs',
  restored.length === 2,
  restored.join(', '),
);

await browser.close();
finish();
