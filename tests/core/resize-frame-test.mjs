// A new view size (rotation, on-screen keyboard) while the page is busy: until the engine shows a
// frame of the new size the canvas shows the last frame unscaled, anchored at the top left and
// cut off or with the rest empty, like Chrome. Before, the old frame was stretched to the new
// size for as long as the page needed (seconds on a heavy page).
//
//   node tests/core/resize-frame-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  screenPixel,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const BUSY_MS = 4000;
const RED = [204, 0, 0];
const BLUE = [0, 0, 204];
// A red bar of 80 px and a blue square of 200 px below it; the first resize after ready keeps the
// engine thread busy, so no frame of the new size comes for BUSY_MS
const PAGE = `<!doctype html><title>Resize frame</title>
<meta name="viewport" content="width=device-width">
<style>body { margin: 0; background: #fff }
#bar { height: 80px; background: rgb(204, 0, 0) } #square { width: 200px; height: 200px; background: rgb(0, 0, 204) }</style>
<div id="bar"></div><div id="square"></div>
<script>
let busy = false;
addEventListener('resize', () => {
  if (!busy) return;
  busy = false;
  const end = Date.now() + ${BUSY_MS};
  while (Date.now() < end);
});
window.arm = () => { busy = true; console.log('RESULT armed=1'); };
console.log('RESULT ready=1');
</script>`;
const { url } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 400, height: 700 }, deviceScaleFactor: 2 });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url })));
await results.wait('ready');
await page.waitForTimeout(1500);

const origin = () =>
  page.evaluate(() => {
    const rect = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
const shown = async (x, y) => {
  const o = await origin();
  const { r, g, b } = await screenPixel(page, Math.round(o.x + x), Math.round(o.y + y));
  return [r, g, b];
};
const before = [await shown(100, 40), await shown(100, 180), await shown(300, 180)];
check(
  'frame before the resize',
  near(before[0], RED) && near(before[1], BLUE) && !near(before[2], BLUE),
  JSON.stringify(before),
);

await page.evaluate(() => window.blTest.eval('arm()'));
await results.wait('armed');
// Portrait to landscape: wider and lower
await page.setViewportSize({ width: 800, height: 350 });
await page.waitForTimeout(1000);
const box = await origin();
// Stretched, the bar would end at y 40, the square would be 400 px wide and end at y 140
const during = [await shown(100, 60), await shown(100, 200), await shown(300, 100)];
check(
  'old frame unscaled while the page is busy',
  near(during[0], RED) && near(during[1], BLUE) && !near(during[2], BLUE),
  `${JSON.stringify(during)} canvas ${JSON.stringify(box)}`,
);
check('canvas box follows the view at once', box.width === 800 && box.height === 350);

// The frame of the new size: the same layout, nothing scaled, white where the old frame ended
const WHITE = [255, 255, 255];
const newFrame = (p) =>
  near(p[0], RED) && near(p[1], BLUE) && near(p[2], WHITE, 10) && near(p[3], WHITE, 10);
let after = [];
await waitFor(async () => {
  after = [
    await shown(100, 60),
    await shown(100, 200),
    await shown(300, 100),
    await shown(700, 300),
  ];
  return newFrame(after);
}, BUSY_MS + 15000);
check('frame of the new size', newFrame(after), JSON.stringify(after));

await browser.close();
finish();
