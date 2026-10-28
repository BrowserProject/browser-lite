// Wheel over a listener that may cancel it (engine/src/ScrollingWasm.cpp, blockingWheelEvent): with
// a free engine thread preventDefault still keeps the page in place; while the page's script
// blocks the engine thread in a long task the page scrolls anyway (like Safari for a trackpad
// gesture), the listener gets the event afterwards as not cancelable.
//
//   node tests/core/scroll-busy-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  pagePixel,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const BLUE = [0, 0, 255];
// Red on top, blue below 200 px; the wheel listener covers the whole page
const PAGE = `<!doctype html><title>Scroll</title>
<style>body { margin: 0 } #top { height: 200px; background: rgb(255, 0, 0) } #rest { height: 5000px; background: rgb(0, 0, 255) }</style>
<div id="area"><div id="top"></div><div id="rest"></div></div>
<script>
window.cancelWheel = false;
let events = 0;
document.getElementById('area').addEventListener('wheel', (event) => {
  events++;
  if (window.cancelWheel) event.preventDefault();
}, { passive: false });
window.busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
window.report = () => console.log('RESULT state=' + Math.round(scrollY) + ',' + events);
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
const box = await page.evaluate(() => {
  const rect = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});
const evalPage = (code) => page.evaluate((code) => window.blTest.eval(code), code);
const state = async () => {
  results.delete('state');
  await evalPage('report()');
  return results.wait('state', 20000);
};
await page.mouse.move(box.x + 100, box.y + 100);

// 1) Free engine thread: preventDefault keeps the page in place
await evalPage('cancelWheel = true');
await page.mouse.wheel(0, 400);
await page.waitForTimeout(1000);
const kept = await state();
check(
  'free engine thread: preventDefault keeps the page in place',
  kept?.startsWith('0,') && Number(kept.split(',')[1]) >= 1,
  kept,
);
await evalPage('cancelWheel = false');

// 2) The page blocks the engine thread for 4 s: the page scrolls meanwhile
await evalPage('setTimeout(() => busy(4000), 0)');
await page.waitForTimeout(300);
const started = Date.now();
await page.mouse.wheel(0, 400);
const scrolled = await waitFor(async () => near(await pagePixel(page, 50, 50), BLUE), 3000, 50);
check(
  'busy engine thread: the page scrolls within the 4 s block',
  scrolled,
  `${Date.now() - started} ms, pixel ${JSON.stringify(await pagePixel(page, 50, 50))}`,
);
// The page learns the new position with its next rendering update after the block
await page.waitForTimeout(Math.max(0, started + 4500 - Date.now()));
let after = null;
await waitFor(async () => Number((after = await state())?.split(',')[0]) >= 300, 5000, 500);
check(
  'the listener got the event afterwards, the page stays scrolled',
  Number(after?.split(',')[0]) >= 300 && Number(after?.split(',')[1]) >= 2,
  after,
);
await browser.close();
finish();
