// Compositing with layers (engine.compositing: true): colors of the tiles, CSS animation
// (transform) without new painting, a fixed bar while scrolling, blur filter and a WebGL canvas
// in a layer. Animation and scrolling go on while the JS of the page blocks (compositor and
// scroll thread). After a GPU loss without layers, after the restore new views with layers.
// Without the compositor (compositing: false) the engine worker paints on the GPU itself, and
// there again after loss and restore. CSS filters: reuse, frame rate, comparison with the CPU.
//
//   node tests/core/compositing-test.mjs [engine-dir]
import {
  BROWSER,
  SWIFTSHADER,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  near,
  openHost,
  openView,
  pagePixel,
  screenshot,
  serve,
  shownPixel,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// Top left three colored boxes, below a box that moves back and forth with a CSS animation, on
// the right a blurred box and a WebGL canvas. The bar at the top is fixed, the page is long
// enough to scroll.
const PAGE = `<!doctype html><title>Compositing test</title>
<style>
  body { margin: 0; background: #fff; height: 3000px; }
  #bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: rgb(255, 128, 0); z-index: 10; }
  .box { position: absolute; width: 60px; height: 60px; }
  #mover { position: absolute; top: 160px; left: 20px; width: 40px; height: 40px; background: rgb(0, 0, 0); will-change: transform; animation: move 1s linear infinite alternate; }
  @keyframes move { from { transform: translateX(0); } to { transform: translateX(300px); } }
  #blur { position: absolute; top: 60px; left: 500px; width: 100px; height: 100px; background: rgb(0, 0, 255); filter: blur(10px); }
  #fade { top: 240px; left: 20px; background: rgb(255, 0, 0); opacity: 0.5; will-change: opacity; }
  canvas { position: absolute; top: 240px; left: 500px; }
</style>
<div id="bar"></div>
<div class="box" style="top:60px;left:20px;background:rgb(255,0,0)"></div>
<div class="box" style="top:60px;left:100px;background:rgb(0,255,0)"></div>
<div class="box" style="top:60px;left:180px;background:rgb(0,0,255)"></div>
<div id="mover"></div>
<div id="blur"></div>
<div class="box" id="fade"></div>
<canvas id="gl" width="80" height="80"></canvas>
<div id="late" style="position:absolute;top:1000px;left:20px;width:60px;height:60px;background:rgb(0,128,0)"></div>
<div id="trap" style="position:absolute;top:1200px;left:20px;width:300px;height:200px;background:rgb(200,200,200)"></div>
<div id="box" style="position:absolute;top:1200px;left:400px;width:200px;height:200px;overflow:auto"><div style="height:300px;background:rgb(255,0,255)"></div><div style="height:700px;background:rgb(0,255,255)"></div></div>
<script>
const gl = document.getElementById('gl').getContext('webgl');
if (gl) {
  gl.clearColor(1, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
let frames = 0;
const count = () => { frames++; requestAnimationFrame(count); };
requestAnimationFrame(count);
setInterval(() => console.log('RESULT frames=' + frames), 500);
// Decode an image asynchronously (img.decode, shared decoder thread)
const source = document.createElement('canvas');
source.width = source.height = 300;
source.getContext('2d').fillStyle = 'rgb(255, 0, 255)';
source.getContext('2d').fillRect(0, 0, 300, 300);
const decoded = new Image();
decoded.src = source.toDataURL('image/png');
decoded.decode().then(() => console.log('RESULT decode=' + decoded.naturalWidth), (e) => console.log('RESULT decode=error'));
// A wheel listener that prevents scrolling: the scroll thread must wait for the page
document.getElementById('trap').addEventListener('wheel', (e) => { e.preventDefault(); console.log('RESULT trapwheel=1'); }, { passive: false });
console.log('RESULT ready=1');
</script>`;

const GPU_PAGE = `<!doctype html><title>GPU-Test</title><body style="margin:0">
<div id="box" style="width:100px;height:100px;background:rgb(255,0,0)"></div>
<script>console.log('RESULT gpuready=1')</script>`;

const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url === '/gpu' ? GPU_PAGE : PAGE),
);

const stack = await startStack({ token: 'compositing-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key) => results.wait(key);
const logs = results.logs;

await openHost(
  page,
  stack.app({ url: siteURL, compositing: '1', log: '1', env: process.env.COMP_ENV || '' }),
);
check('page loaded', (await result('ready')) === '1');

const pixelAt = (x, y, target = page) => pagePixel(target, x, y);
// Wait for a frame with content (tiles are painted in the background)
await waitFor(async () => near(await pixelAt(50, 90), [255, 0, 0]));
await screenshot(page, 'compositing-top');
const red = await pixelAt(50, 90),
  green = await pixelAt(130, 90),
  blue = await pixelAt(210, 90);
check(
  'colors right (red, green, blue)',
  near(red, [255, 0, 0]) && near(green, [0, 255, 0]) && near(blue, [0, 0, 255]),
  JSON.stringify({ red, green, blue }),
);
const bar = await pixelAt(500, 20);
check('fixed bar at the top', near(bar, [255, 128, 0]), JSON.stringify(bar));
check(
  'compositing is on',
  logs.some((line) => /Compositor: own thread/.test(line)) &&
    !logs.some((line) => /compositing off/.test(line)),
);

// The animation runs: the black box is sometimes left, sometimes further right. Left edge of
// the black box in row y=180 (rounded to 50 px), all points from the same frame
const moverX = async () => {
  const row = await page.evaluate(() => window.blTest.pageRow(180));
  const x = row ? row.findIndex((pixel) => near(pixel, [0, 0, 0], 60)) : -1;
  return x < 0 ? null : Math.round(x / 50) * 50;
};
const positions = new Set();
for (let i = 0; i < 20; i++) {
  const x = await moverX();
  if (x !== null) positions.add(x);
  await page.waitForTimeout(100);
}
check('CSS animation (transform) moves', positions.size >= 2, JSON.stringify([...positions]));

const fade = await pixelAt(50, 270);
check('half transparent (opacity)', near(fade, [255, 128, 128], 50), JSON.stringify(fade));
const blurCenter = await pixelAt(550, 110),
  blurEdge = await pixelAt(500, 110);
check(
  'blur filter',
  near(blurCenter, [0, 0, 255], 60) && blurEdge[2] > 60 && blurEdge[0] > 60,
  JSON.stringify({ blurCenter, blurEdge }),
);
let yellow = null;
await waitFor(async () => near((yellow = await pixelAt(540, 280)), [255, 255, 0]), 10000);
check('WebGL canvas in a layer', near(yellow, [255, 255, 0]), JSON.stringify(yellow));

check(
  'img.decode() (image decoded in the background)',
  (await result('decode')) === '300',
  results.get('decode'),
);

const framesBefore = Number(await result('frames'));
await page.waitForTimeout(2000);
results.delete('frames');
const framesAfter = Number(await result('frames'));
check(
  'requestAnimationFrame keeps running',
  framesAfter - framesBefore > 10,
  `${framesBefore} -> ${framesAfter}`,
);

// The JS of the page blocks the engine thread for ms. Resolves the time before which it surely
// still blocks (the loop starts after the call).
async function blockPage(ms) {
  const until = Date.now() + ms;
  await page.evaluate(
    (source) => window.blTest.eval(source),
    `(() => { const end = Date.now() + ${ms}; while (Date.now() < end); return 1; })()`,
  );
  return until;
}

// Until the pixel at x, y has the color, at most while the page still blocks. inTime: it came
// before the end of the block; pixel: the last color seen.
async function pixelWhileBlocked(x, y, rgb, until) {
  let pixel = null;
  let seen = 0;
  const found = await waitFor(async () => {
    pixel = await pixelAt(x, y);
    seen = Date.now();
    return near(pixel, rgb);
  }, until - Date.now());
  return { inTime: found && seen < until, pixel };
}

// The animation goes on in the compositor thread, even when the JS of the page blocks the
// engine thread for 3 s
async function positionsWhileBlocked() {
  await blockPage(3000);
  await page.waitForTimeout(400);
  const positions = new Set();
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const x = await moverX();
    if (x !== null) positions.add(x);
    await page.waitForTimeout(80);
  }
  return positions;
}
const busyPositions = await positionsWhileBlocked();
check(
  'animation goes on while the JS blocks',
  busyPositions.size >= 2,
  JSON.stringify([...busyPositions]),
);
if (busyPositions.size < 2)
  console.log(
    logs
      .filter((line) => /Compositor|tile|GPU/.test(line))
      .slice(-20)
      .join('\n'),
  );
await page.waitForTimeout(1500);

// Scrolling: the content moves, the bar stays
await page.mouse.move(500, 400);
await page.mouse.wheel(0, 900);
let scrolled = null;
await waitFor(async () => near((scrolled = await pixelAt(50, 130)), [0, 128, 0]), 10000);
check('scrolling moves the content', near(scrolled, [0, 128, 0]), JSON.stringify(scrolled));
check('bar stays while scrolling', near(await pixelAt(500, 20), [255, 128, 0]));

// Scrolling in the scroll thread: works even while the JS of the page blocks the engine thread
// for 5 s
const busyUntil = await blockPage(5000);
await page.waitForTimeout(500);
await page.mouse.wheel(0, -900);
const busyScrolled = await pixelWhileBlocked(50, 90, [255, 0, 0], busyUntil);
check('scrolling while the JS blocks', busyScrolled.inTime, JSON.stringify(busyScrolled.pixel));
// Afterwards the page knows the new position too
await page.waitForTimeout(4000);
results.delete('scrollY');
await page.evaluate(() => window.blTest.eval('console.log("RESULT scrollY=" + scrollY)'));
check('page knows the scroll position', (await result('scrollY')) === '0');
await page.mouse.wheel(0, 900);
await waitFor(async () => near(await pixelAt(50, 130), [0, 128, 0]), 10000);

// wheel listener with preventDefault: the page does not scroll
await page.mouse.move(100, 400);
await page.mouse.wheel(0, 300);
const trapped = await result('trapwheel');
await page.waitForTimeout(1000);
check(
  'preventDefault in the wheel listener prevents scrolling',
  trapped === '1' && near(await pixelAt(50, 130), [0, 128, 0]),
  JSON.stringify(await pixelAt(50, 130)),
);

// A box with overflow: auto scrolls in the scroll thread, also while the JS blocks
check(
  'scroll box violet at the top',
  near(await pixelAt(500, 320), [255, 0, 255]),
  JSON.stringify(await pixelAt(500, 320)),
);
const boxUntil = await blockPage(4000);
await page.waitForTimeout(500);
await page.mouse.move(500, 400);
await page.mouse.wheel(0, 400);
const boxScrolled = await pixelWhileBlocked(500, 320, [0, 255, 255], boxUntil);
check(
  'box scrolls while the JS blocks',
  boxScrolled.inTime && near(await pixelAt(50, 130), [0, 128, 0]),
  JSON.stringify(boxScrolled.pixel),
);
await page.waitForTimeout(3500);

// GPU lost: the engine keeps painting on the CPU without layers
await page.evaluate(() => window.blTest.browser.debug.gpu('lose'));
await waitFor(async () => logs.some((line) => /compositing off/.test(line)), 15000);
await page.waitForTimeout(1000);
// A change after the loss must arrive (not only the old frame)
await page.evaluate(() =>
  window.blTest.eval('document.getElementById("late").style.background = "rgb(0, 0, 255)"'),
);
let afterLoss = null;
await waitFor(async () => near((afterLoss = await pixelAt(50, 130)), [0, 0, 255]), 10000);
const barAfterLoss = await pixelAt(500, 20);
check(
  'painting continues after GPU loss (without layers)',
  near(afterLoss, [0, 0, 255]) && near(barAfterLoss, [255, 128, 0]),
  JSON.stringify({ afterLoss, barAfterLoss }),
);

// The browser restores the context: a new view gets layers again
await page.evaluate(() => window.blTest.browser.debug.gpu('restore'));
check(
  'GPU restored',
  await waitFor(async () => logs.some((line) => /GPU: WebGL context is back/.test(line)), 10000),
);
const stopsBefore = logs.filter((line) => /compositing off/.test(line)).length;
results.delete('ready');
await openView(page, siteURL);
check('new view after the restore', (await result('ready')) === '1');
await waitFor(async () => near(await pixelAt(50, 90), [255, 0, 0]));
const restoredPositions = await positionsWhileBlocked();
check(
  'new view with layers: animation runs while the JS blocks',
  restoredPositions.size >= 2 &&
    logs.filter((line) => /compositing off/.test(line)).length === stopsBefore,
  JSON.stringify([...restoredPositions]),
);

await screenshot(page, 'compositing');
await page.close();

// Without the compositor: GPU lost, then restored. Afterwards the view paints on the GPU again
// (not just somehow), without falling back to the CPU.
const gpuPage = await browser.newPage({ viewport: { width: 600, height: 400 } });
const gpuResults = collect(gpuPage);
const gpuLogs = gpuResults.logs;
const gpuLog = (pattern) => gpuLogs.some((line) => pattern.test(line));
await openHost(gpuPage, stack.app({ url: `${siteURL}gpu`, compositing: '0', log: '1' }));
check('loaded without the compositor', (await gpuResults.wait('gpuready')) === '1');
const boxColor = (rgb) =>
  gpuPage.evaluate(
    (rgb) => window.blTest.eval(`document.getElementById("box").style.background = "rgb(${rgb})"`),
    rgb.join(', '),
  );
// Pixel of the box as soon as it has the color (else the last one after 10 s)
const boxPixel = async (rgb) => {
  let pixel = null;
  // Without the compositor from the screen (shownPixel)
  await waitFor(async () => near((pixel = await shownPixel(gpuPage, 50, 50)), rgb), 10000);
  return pixel;
};
let box = await boxPixel([255, 0, 0]);
check(
  'without the compositor: the engine worker paints on the GPU',
  near(box, [255, 0, 0]) &&
    gpuLog(/GPU: Skia paints through WebGL 2/) &&
    !gpuLog(/Compositor: own thread/),
  JSON.stringify(box),
);
await gpuPage.evaluate(() => window.blTest.browser.debug.gpu('lose'));
await waitFor(async () => gpuLog(/GPU: WebGL context lost/), 10000);
await boxColor([0, 0, 255]);
box = await boxPixel([0, 0, 255]);
// Firefox shows no frame of the worker that lost its WebGL context until it is back (only without
// the compositor thread, an expert setting; status.md)
if (BROWSER === 'firefox')
  console.log('skip without the compositor: painted on the CPU after GPU loss (Firefox)');
else
  check(
    'without the compositor: painted on the CPU after GPU loss',
    near(box, [0, 0, 255]),
    JSON.stringify(box),
  );
await gpuPage.evaluate(() => window.blTest.browser.debug.gpu('restore'));
const viewsBack = await waitFor(async () => gpuLog(/GPU: views back on the GPU: 1/), 10000);
await boxColor([0, 160, 0]);
box = await boxPixel([0, 160, 0]);
check(
  'without the compositor: painted on the GPU again after the restore',
  viewsBack && near(box, [0, 160, 0]) && !gpuLog(/frame not brought to the GPU/),
  JSON.stringify(box),
);
// Loss and restore right after each other, before the next frame: no surface of the old
// context may be left
const restores = () => gpuLogs.filter((line) => /GPU: views back on the GPU: 1/.test(line)).length;
await gpuPage.evaluate(() => {
  window.blTest.browser.debug.gpu('lose');
  window.blTest.browser.debug.gpu('restore');
});
const backAgain = await waitFor(async () => restores() === 2, 10000);
await boxColor([255, 0, 255]);
box = await boxPixel([255, 0, 255]);
check(
  'without the compositor: loss and restore right after each other',
  backAgain && near(box, [255, 0, 255]) && !gpuLog(/frame not brought to the GPU/),
  JSON.stringify(box),
);
await gpuPage.close();

// CSS filters on the GPU: the compositor computes blur and shadow. A layer without change keeps
// its filtered image (patch 0036), a moved one filters in its layer and comes back onto the
// device pixels after it stops. Variants: still (no movement), nofilter (without filters, to
// compare the frame rate)
function filterPage(params) {
  const still = params.has('still'),
    nofilter = params.has('nofilter');
  const filter = (value) => (nofilter ? 'none' : value);
  const cards = [];
  for (let i = 0; i < 12; i++) {
    const left = 20 + (i % 6) * 160,
      top = 20 + Math.floor(i / 6) * 150;
    cards.push(
      `<div class="card" style="left:${left}px;top:${top}px;filter:${filter(i % 2 ? 'drop-shadow(6px 6px 4px rgb(0,0,0))' : 'blur(4px)')}">Card ${i}</div>`,
    );
  }
  return `<!doctype html><title>Filter test</title><style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  .card { position: absolute; width: 120px; height: 100px; background: linear-gradient(135deg, rgb(255, 160, 0), rgb(0, 120, 255)); color: #fff; }
  #mover { top: 340px; left: 20px; filter: ${filter('blur(3px)')}; ${still ? '' : 'animation: slide 1s linear infinite alternate;'} }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(300px); } }
  #change { position: absolute; top: 340px; left: 700px; width: 100px; height: 100px; background: rgb(255, 0, 0); filter: ${filter('blur(6px)')}; }
  #settle { top: 500px; left: ${still ? 60 : 20}px; filter: ${filter('drop-shadow(6px 6px 4px rgb(0,0,0))')}; transition: transform 0.3s linear; }
</style>${cards.join('')}
<div class="card" id="mover">Moving</div><div id="change"></div><div class="card" id="settle">Still</div>
<script>
${still ? '' : "requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById('settle').style.transform = 'translateX(40px)'; }));"}
console.log('RESULT filterready=1');
</script>`;
}
const { url: filterURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(filterPage(new URL(req.url, 'http://localhost').searchParams)),
);

// Rows with the still cards and the box that stands after the movement
const FILTER_ROWS = [40, 70, 100, 125, 190, 220, 250, 275, 520, 550, 580, 605];
async function openFilterPage(query, compositing) {
  const filterTab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const filterResults = collect(filterTab);
  await openHost(filterTab, stack.app({ url: filterURL + query, compositing, log: '1' }));
  check(
    `filter page ${query} (compositing=${compositing}) loaded`,
    (await filterResults.wait('filterready')) === '1',
  );
  // Tiles painted, transition done, moved layers back on the device pixels
  await waitFor(async () =>
    ((await pixelAt(80, 70, filterTab)) || [255]).some((value) => value < 200),
  );
  await filterTab.waitForTimeout(2500);
  return filterTab;
}
const filterRows = (target) =>
  target.evaluate((ys) => ys.map((y) => window.blTest.pageRow(y)), FILTER_ROWS);
const rowDiff = (a, b) => {
  let max = 0,
    sum = 0,
    count = 0;
  a.forEach((row, i) =>
    row.forEach((pixel, x) =>
      pixel.forEach((value, c) => {
        const diff = Math.abs(value - b[i][x][c]);
        max = Math.max(max, diff);
        sum += diff;
        count++;
      }),
    ),
  );
  return { max, mean: +(sum / count).toFixed(2) };
};
// Frames of the compositor per second (rAF in its worker, from the Chrome trace)
async function compositorFps(target) {
  await browser.startTracing(target, { categories: ['devtools.timeline'] });
  await target.waitForTimeout(3000);
  const trace = JSON.parse((await browser.stopTracing()).toString());
  const frames = new Map();
  for (const event of trace.traceEvents) {
    if (event.name === 'FireAnimationFrame' && event.ph === 'X')
      frames.set(event.tid, (frames.get(event.tid) || 0) + 1);
  }
  return Math.max(0, ...frames.values()) / 3;
}

const animated = await openFilterPage('', '1');
const animatedRows = await filterRows(animated);
await animated.evaluate(() =>
  window.blTest.eval('document.getElementById("change").style.background = "rgb(0, 0, 255)"'),
);
let changed = null;
await waitFor(async () => near((changed = await pixelAt(750, 390, animated)), [0, 0, 255]), 10000);
check('filtered layer shows new content', near(changed, [0, 0, 255]), JSON.stringify(changed));
// The frame rate comes from the Chrome trace
const filterFps = chromiumOnly('frame rate with blur and shadow')
  ? await compositorFps(animated)
  : null;
await animated.close();
if (filterFps !== null) {
  const plain = await openFilterPage('?nofilter', '1');
  const plainFps = await compositorFps(plain);
  await plain.close();
  check(
    'frame rate with blur and shadow almost like without filters',
    plainFps > 10 && filterFps >= 0.5 * plainFps,
    `${filterFps.toFixed(1)} vs ${plainFps.toFixed(1)} frames/s`,
  );
}

const still = await openFilterPage('?still', '1');
const stillRows = await filterRows(still);
await still.close();
const reuse = rowDiff(animatedRows, stillRows);
check('reused and realigned filters like without movement', reuse.max <= 2, JSON.stringify(reuse));

const cpu = await openFilterPage('?still', '0');
const cpuRows = await filterRows(cpu);
await cpu.close();
const gpuVsCpu = rowDiff(stillRows, cpuRows);
check(
  'filters on the GPU like on the CPU (without the compositor)',
  gpuVsCpu.max <= 16 && gpuVsCpu.mean <= 1,
  JSON.stringify(gpuVsCpu),
);

// Many small backdrop filters side by side (espn.com: 11). Each backdrop paints the layers before
// it again, with their backdrops: without skipping the ones outside the clip (patch 0065) that was
// exponential, the first frame never came (Chromium) or the stack overflowed (Safari)
const badges = [];
for (let i = 0; i < 24; i++)
  badges.push(
    `<div style="position:absolute;left:${20 + (i % 8) * 110}px;top:${200 + Math.floor(i / 8) * 60}px;width:80px;height:30px;backdrop-filter:blur(2px);background:rgba(255,255,255,0.3)"></div>`,
  );
const { url: backdropURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><body style="margin:0;background:linear-gradient(90deg,rgb(0,120,255),rgb(255,160,0))"><div style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:rgb(0,255,0)"></div>${badges.join('')}<script>console.log('RESULT backdropready=1')</script>`,
    ),
);
const backdropTab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const backdropResults = collect(backdropTab);
await openHost(backdropTab, stack.app({ url: backdropURL, compositing: '1' }));
await backdropResults.wait('backdropready');
const backdropStart = Date.now();
let backdropPixel = null;
await waitFor(
  async () => near((backdropPixel = await pixelAt(70, 70, backdropTab)), [0, 255, 0]),
  15000,
);
check(
  '24 small backdrop filters: the first frame comes',
  near(backdropPixel, [0, 255, 0]),
  `${JSON.stringify(backdropPixel)} after ${Date.now() - backdropStart} ms`,
);
await backdropTab.close();
await browser.close();
finish();
