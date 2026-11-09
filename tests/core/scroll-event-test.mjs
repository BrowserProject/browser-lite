// The view's `scroll` event: the main frame's position with `user` true for a scroll by the
// user (wheel) and false for one by the page's script or a clamp of a larger view, which a
// browser needs to hide its toolbar like Chrome (apps/demo bar-hiding.ts).
//
//   node tests/core/scroll-event-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  hostEvents,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Scroll</title>
<style>body { margin: 0 } div { height: 1000px }</style><div></div>
<script>console.log('RESULT ready=1')</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
const evalPage = (code) => page.evaluate((code) => window.blTest.eval(code), code);
const scrolls = async () => (await hostEvents(page)).filter((e) => e.startsWith('scroll:'));
const clear = () => page.evaluate(() => window.blHost.events.splice(0));

// The page's script
await clear();
await evalPage('scrollTo(0, 100)');
check('script: y and not by the user', !!(await waitEvent(page, 'scroll:100:false', 10000)));

// The wheel
const box = await page.evaluate(() => {
  const rect = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
  return { x: rect.left + 100, y: rect.top + 100 };
});
await page.mouse.move(box.x, box.y);
await clear();
await page.mouse.wheel(0, 300);
const wheel = await waitEvent(page, /^scroll:\d+:true$/, 10000);
check('wheel: by the user', !!wheel, JSON.stringify(await scrolls()));
await page.waitForTimeout(1000);
const all = await scrolls();
const last = Number(all.at(-1)?.split(':')[1]);
check(
  'wheel: y grows to where the page is',
  last > 100 && all.every((e) => e.endsWith(':true')),
  JSON.stringify(all),
);

// At the bottom a taller view clamps the position: not by the user
await evalPage('scrollTo(0, 5000)');
await page.waitForTimeout(1000);
await clear();
const host = await page.evaluate(() => {
  const rect = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
  return rect.height;
});
await page.setViewportSize({ width: 800, height: 700 });
await page.waitForTimeout(1500);
const clamped = await scrolls();
check(
  'a taller view at the bottom: a smaller y, not by the user',
  clamped.length > 0 && clamped.every((e) => e.endsWith(':false')),
  `${host} ${JSON.stringify(clamped)}`,
);
await browser.close();
finish();
