// A navigation that ends without a new page while the page being left still delays its load event.
// The engine pauses the page being left until the new page answers (#337). Starting the
// navigation cancels the page's own loads, and an async script whose load was cancelled then
// waits in the paused page to fire its error event, which delays the page's load event. WebCore
// reported a failed or stopped navigation only once that page stopped delaying, so neither ever
// came: the tab stayed loading without an error page, Stop did nothing and the page stayed paused
// (bing.com a few seconds after its load, #576). Here the page inserts a script that never
// arrives; a navigation to a closed port gets its error page, a stopped navigation to a server
// that never answers ends loading and the page runs on.
//
//   node tests/core/failed-navigation-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  finish,
  freePort,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const held = [];
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/never.js' || path === '/never') {
    held.push(res);
    return;
  }
  if (path !== '/busy') return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>busy:0</title>
<script>
let n = 0;
setInterval(() => { document.title = 'busy:' + ++n; }, 100);
onload = () => setTimeout(() => {
  const script = document.createElement('script');
  script.src = '/never.js';
  document.body.append(script);
  console.log('script inserted');
}, 100);
</script>`);
});

const stack = await startStack({ token: 'failed-navigation-token-0123456789' });
const browser = await launch();
const tab = await browser.newPage();
const view = (name) => tab.evaluate((name) => window.blTest.view()[name], name);
const ticks = async () => Number((await view('title'))?.split(':')[1] ?? -1);
const events = () => tab.evaluate(() => window.blHost.events.length);
const eventsSince = (start) => tab.evaluate((start) => window.blHost.events.slice(start), start);

// Until predicate() is true, at most ms
async function until(predicate, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await tab.waitForTimeout(100))
    if (await predicate()) return true;
  return false;
}

// Opens the page and waits until its script is on the way
async function openBusy() {
  const start = await events();
  await load(tab, `${siteURL}busy`);
  return until(
    async () => (await eventsSince(start)).some((event) => event.endsWith(':script inserted')),
    30000,
  );
}

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));

// 1. A failed navigation gets its error page
check('page with a script on the way', await openBusy());
await tab.waitForTimeout(300);
let start = await events();
const closedPort = await freePort();
await load(tab, `http://127.0.0.1:${closedPort}/`);
check(
  'a failed navigation gets its error page',
  await until(async () => (await eventsSince(start)).includes('commit:network'), 10000),
  JSON.stringify((await eventsSince(start)).filter((event) => !event.startsWith('progress'))),
);
check(
  'the error page loads',
  await until(async () => (await eventsSince(start)).includes('load'), 10000),
);

// 2. Stop ends a navigation that has no answer yet, and the page runs on
check('page with a script on the way again', await openBusy());
await tab.waitForTimeout(300);
start = await events();
await load(tab, `${siteURL}never`);
await tab.waitForTimeout(1000);
const pausedAt = await ticks();
await tab.waitForTimeout(500);
check(
  'the page being left pauses',
  (await view('loading')) && (await ticks()) === pausedAt,
  `${pausedAt} -> ${await ticks()}`,
);
await tab.evaluate(() => window.blTest.view().stop());
check('Stop ends loading', await until(async () => !(await view('loading')), 5000));
const resumedAt = await ticks();
await tab.waitForTimeout(600);
check(
  'the page runs on after Stop',
  (await ticks()) > resumedAt,
  `${resumedAt} -> ${await ticks()}`,
);
check('the view stays at the page', (await view('url')) === `${siteURL}busy`, await view('url'));
await tab.waitForTimeout(500);
check(
  'no error page after Stop',
  !(await eventsSince(start)).some((event) => /^commit:./.test(event)),
);

await browser.close();
for (const res of held) res.destroy();
finish();
