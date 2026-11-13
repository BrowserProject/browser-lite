// Host layers (engine/src/HostLayers.h, packages/core/src/view-host-layers.ts): pulsing
// placeholders, layers that only animate their opacity, get canvases of their own over the view
// canvas once they stand still, and the host runs their opacity; the engine shows no frame for them
// then (with BL_HOST_LAYERS=0 every tick is a frame). A placeholder covered by a later layer stays in
// the frames, one under a plain later layer gets that layer as a cover canvas above it. What the host
// layers and covers show is what the view shows once the animations
// are paused and the layers are back in the frames. Scrolling puts them back, they come again at the
// new place; a placeholder whose animation ends goes back for good; new contents of a layer go into
// its canvas. Layers that also scale and move (Wikipedia's pulsating dot) get host layers whose
// transform the host runs, unless the animation leaves their clip. At device pixel ratio 1 and 2.
// A layer whose transform and opacity animations took long to add (many keyframes) gets one too:
// the animations of one CSS animation start on one clock reading (patch 0132).
//
//   node tests/core/host-layers-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Six placeholders that fade from 1 to 0.5 in 60 s (so a pixel changes by about 2 levels per
// second, and still every frame), and two more: one under a plain later layer (#cover, its cover),
// one under a translucent later layer (#veil, keeps it in the frames)
const BOXES = 6;
const PAGE = `<!doctype html><title>Host layers</title>
<style>
  body { margin: 0; background: #fff; height: 3000px; }
  .box { position: absolute; width: 120px; height: 60px; border-radius: 8px; background: rgb(0, 64, 255);
    animation: fade 60s linear infinite alternate; }
  @keyframes fade { to { opacity: 0.5; } }
  #cover { position: absolute; left: 60px; top: 250px; width: 60px; height: 60px; background: rgb(255, 128, 0);
    will-change: transform; }
  #veil { position: absolute; left: 220px; top: 250px; width: 60px; height: 60px; background: rgb(255, 128, 0);
    opacity: 0.8; will-change: opacity; }
</style>
${Array.from({ length: BOXES }, (_, i) => `<div class="box" style="left:${20 + (i % 3) * 160}px;top:${40 + Math.floor(i / 3) * 100}px"></div>`).join('')}
<div class="box" id="covered" style="left:20px;top:240px"></div><div id="cover"></div>
<div class="box" id="veiled" style="left:180px;top:240px"></div><div id="veil"></div>
<script>console.log('RESULT ready=1');</script>`;
// Wikipedia's pulsating dot (scale and opacity, 3 s), a disc that shrinks, moves and fades so
// slowly that its edge moves by less than a tenth of a pixel per second (the pixels to compare) under
// a masked icon (its cover, like Wikipedia's bookmark icon over the dot), and a box that grows out of its clip (stays in the frames)
const TRANSFORM_PAGE = `<!doctype html><title>Host layers with transforms</title>
<style>
  body { margin: 0; background: #fff; }
  .mw-pulsating-dot { position: absolute; left: 420px; top: 80px; width: 12px; height: 12px; }
  .mw-pulsating-dot::before, .mw-pulsating-dot::after { content: ''; display: block; position: absolute;
    border-radius: 50%; background-color: #36c; }
  .mw-pulsating-dot::before { width: 36px; height: 36px; top: -18px; left: -18px; opacity: 0;
    animation: mw-pulsating-dot-pulse 3s ease-out; animation-iteration-count: infinite; }
  .mw-pulsating-dot::after { width: 12px; height: 12px; top: -6px; left: -6px; }
  @keyframes mw-pulsating-dot-pulse { 0% { transform: scale(0); opacity: 0 } 25% { transform: scale(0); opacity: 0.1 }
    50% { transform: scale(0.1); opacity: 0.3 } 75% { transform: scale(0.5); opacity: 0.5 } 100% { transform: scale(1); opacity: 0 } }
  #disc { position: absolute; left: 100px; top: 200px; width: 80px; height: 80px; border-radius: 40px;
    background: rgb(0, 64, 255); animation: shrink 600s linear infinite alternate; }
  @keyframes shrink { from { transform: scale(0.9); opacity: 0.9 } to { transform: translate(40px, 20px) scale(0.5); opacity: 0.5 } }
  #icon { position: absolute; left: 150px; top: 230px; width: 20px; height: 20px; background: rgb(255, 128, 0);
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M3 2h14v16l-7-5-7 5z'/%3E%3C/svg%3E");
    mask-size: 100% 100%; }
  #clip { position: absolute; left: 500px; top: 200px; width: 60px; height: 60px; overflow: hidden; }
  #grows { width: 60px; height: 60px; background: rgb(0, 160, 0); animation: grow 2s infinite alternate; }
  @keyframes grow { to { transform: scale(1.5); } }
</style>
<span class="mw-pulsating-dot"></span><div id="disc"></div><div id="icon"></div><div id="clip"><div id="grows"></div></div>
<script>console.log('RESULT ready=1');</script>`;
// A box that shrinks through many keyframes and fades through two: the engine adds its transform
// animation and its opacity animation to the layer one after the other, the first one taking long
// enough to copy that a clock read for each would put them on two timelines (more than a
// millisecond apart, the case of 1 in 6 loads of Wikipedia's dot on a busy host)
const KEYFRAMES = 4000;
const KEYFRAMES_PAGE = `<!doctype html><title>Host layers with many keyframes</title>
<style>
  body { margin: 0; background: #fff; }
  #keyed { position: absolute; left: 100px; top: 100px; width: 80px; height: 80px; background: rgb(0, 64, 255);
    animation: keyed 4s linear infinite alternate; }
  @keyframes keyed { ${Array.from({ length: KEYFRAMES + 1 }, (_, i) => `${((i * 100) / KEYFRAMES).toFixed(3)}% { transform: scale(${(0.9 - (0.1 * i) / KEYFRAMES).toFixed(6)}) }`).join(' ')}
    0% { opacity: 1 } 100% { opacity: 0.6 } }
</style>
<div id="keyed"></div>
<script>console.log('RESULT ready=1');</script>`;
const { url: siteURL } = await serve((req, res) => {
  const page = req.url.startsWith('/transform')
    ? TRANSFORM_PAGE
    : req.url.startsWith('/keyframes')
      ? KEYFRAMES_PAGE
      : PAGE;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
});
const transformURL = new URL('/transform', siteURL).href;
const keyframesURL = new URL('/keyframes', siteURL).href;

/** The host layers: key, place in frame pixels and whether the host runs a transform. */
const hostLayers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('canvas[data-bl-layer]')].map((canvas) => ({
      key: canvas.getAttribute('data-bl-layer'),
      x: Number.parseFloat(canvas.style.left),
      y: Number.parseFloat(canvas.style.top),
      transform: getComputedStyle(canvas).transform !== 'none',
    })),
  );

/**
 * Frame pixels of the view (base64 RGBA) as the host shows them: the view canvas, the damage tiles
 * and the host layers at their current opacity.
 */
const shown = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-bl-view]');
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    for (const over of document.querySelectorAll('[data-bl-tiles] canvas')) {
      const style = getComputedStyle(over);
      context.save();
      context.globalAlpha = Number(style.opacity);
      context.translate(Number.parseFloat(over.style.left), Number.parseFloat(over.style.top));
      if (style.transform !== 'none') {
        const m = new DOMMatrix(style.transform);
        context.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      context.drawImage(over, 0, 0);
      context.restore();
    }
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000)
      text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return { width: probe.width, data: btoa(text) };
  });

// Pixels more than `tolerance` apart in a channel, and the largest difference
const compare = (a, b, tolerance) => {
  const x = Buffer.from(a.data, 'base64');
  const y = Buffer.from(b.data, 'base64');
  if (x.length !== y.length) return { pixels: Number.POSITIVE_INFINITY, largest: 0 };
  let pixels = 0;
  let largest = 0;
  for (let i = 0; i < x.length; i += 4) {
    let differs = false;
    for (let c = i; c < i + 3; c++) {
      const d = Math.abs(x[c] - y[c]);
      largest = Math.max(largest, d);
      if (d > tolerance) differs = true;
    }
    if (differs) pixels++;
  }
  return { pixels, largest };
};

// Where a shape shows within `region` (frame pixels): the bounds of the pixels that differ from
// white by more than half, and its coverage (the sum of how far each pixel is from white, in pixels)
// with its centre
const shape = (image, region) => {
  const data = Buffer.from(image.data, 'base64');
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = region.top; y <= region.bottom; y++) {
    for (let x = region.left; x <= region.right; x++) {
      const i = (y * image.width + x) * 4;
      const darkness = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
      area += darkness / 255;
      sumX += (darkness / 255) * x;
      sumY += (darkness / 255) * y;
      if (darkness < 128) continue;
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  return { ...box, area, x: sumX / area, y: sumY / area };
};

const framesIn = async (page, ms) => {
  const before = await page.evaluate(() => window.blTest.framesShown());
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.blTest.framesShown())) - before;
};

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });

for (const ratio of [1, 2]) {
  const label = `ratio ${ratio}`;
  const open = async (env) => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: ratio,
    });
    watchErrors(page);
    const results = collect(page);
    check(
      `${label}${env ? ` ${env}` : ''}: page loaded`,
      await openHost(page, stack.app({ url: siteURL, env })),
    );
    await results.wait('ready');
    return page;
  };

  // The reference: every tick of the fading boxes is a frame
  const reference = await open('BL_HOST_LAYERS=0');
  await reference.waitForTimeout(1500);
  await evalPage(reference, `document.getElementById('veiled').getAnimations()[0].pause()`);
  await reference.waitForTimeout(300);
  const referenceFrames = await framesIn(reference, 2000);
  const referenceLayers = (await hostLayers(reference)).length;
  await reference.close();

  const page = await open('');
  let layers = [];
  await waitFor(async () => (layers = await hostLayers(page)).length >= BOXES + 1, 15000, 200);
  await page.waitForTimeout(500);
  layers = await hostLayers(page);
  const covers = await page.evaluate(
    () => document.querySelectorAll('canvas[data-bl-cover]').length,
  );
  check(
    `${label}: the placeholders get host layers, the one under a plain layer with a cover, the one under a translucent layer not`,
    layers.length === BOXES + 1 && covers === 1 && referenceLayers === 0,
    `${layers.length} host layers, ${covers} covers, the reference ${referenceLayers}`,
  );
  // The placeholder under the translucent layer stays in the frames: paused, nothing else changes them
  await evalPage(page, `document.getElementById('veiled').getAnimations()[0].pause()`);
  await page.waitForTimeout(300);
  const frames = await framesIn(page, 2000);
  check(
    `${label}: no frames while the host animates them`,
    frames <= 4 && referenceFrames >= 40,
    `${frames} frames in 2 s, the reference ${referenceFrames}`,
  );

  // Paused, the layers go back into the frames at the opacity they have now
  const withLayers = await shown(page);
  await evalPage(page, 'document.getAnimations().forEach((a) => a.pause())');
  await waitFor(async () => (await hostLayers(page)).length === 0, 5000, 100);
  await page.waitForTimeout(500);
  const paused = await shown(page);
  const difference = compare(withLayers, paused, 3);
  check(
    `${label}: the host layers showed what the view shows`,
    (await hostLayers(page)).length === 0 && difference.pixels === 0,
    JSON.stringify(difference),
  );

  // Running again, then scrolled: back into the frames, then host layers at the new place
  await evalPage(page, 'document.getAnimations().forEach((a) => a.play())');
  await waitFor(async () => (await hostLayers(page)).length === BOXES + 1, 10000, 200);
  const before = await hostLayers(page);
  // Firefox under Playwright keeps a pixel ratio of 1
  const pixelRatio = await page.evaluate(() => devicePixelRatio);
  await evalPage(page, 'scrollBy(0, 30)');
  let after = [];
  await waitFor(
    async () =>
      (after = await hostLayers(page)).length === BOXES + 1 &&
      after.every((layer) => !before.some((old) => old.key === layer.key)),
    10000,
    100,
  );
  const moved =
    after.length === BOXES + 1 &&
    after.every((layer) =>
      before.some((old) => old.x === layer.x && Math.abs(old.y - 30 * pixelRatio - layer.y) <= 1),
    );
  check(
    `${label}: scrolled, the host layers come again at the new place`,
    moved,
    JSON.stringify({ before, after }),
  );

  // An animation that ends puts its layer back for good
  await evalPage(page, `document.querySelector('.box').style.animation = 'none'`);
  await waitFor(async () => (await hostLayers(page)).length === BOXES, 5000, 100);
  await page.waitForTimeout(1000);
  check(
    `${label}: a placeholder that stops goes back into the frames`,
    (await hostLayers(page)).length === BOXES,
  );
  // New contents of a layer the host shows go into its canvas
  const keys = (await hostLayers(page)).map((layer) => layer.key).join();
  await evalPage(page, `document.querySelectorAll('.box')[1].style.background = 'rgb(0, 160, 0)'`);
  await page.waitForTimeout(1000);
  check(
    `${label}: new contents keep the host layers`,
    (await hostLayers(page)).map((layer) => layer.key).join() === keys,
  );
  const settled = await shown(page);
  await evalPage(page, 'document.getAnimations().forEach((a) => a.pause())');
  await waitFor(async () => (await hostLayers(page)).length === 0, 5000, 100);
  await page.waitForTimeout(500);
  const end = compare(settled, await shown(page), 3);
  check(
    `${label}: after scrolling and new contents the host layers showed what the view shows`,
    end.pixels === 0,
    JSON.stringify(end),
  );
  await page.close();

  // Layers that scale and move: the host runs their transform too
  const transformReference = await open('BL_HOST_LAYERS=0');
  await evalPage(transformReference, `document.getElementById('grows').getAnimations()[0].pause()`);
  await transformReference.waitForTimeout(1500);
  const transformReferenceFrames = await framesIn(transformReference, 2000);
  await transformReference.close();
  const transformed = await browser.newPage({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: ratio,
  });
  watchErrors(transformed);
  const transformResults = collect(transformed);
  check(
    `${label} transforms: page loaded`,
    await openHost(transformed, stack.app({ url: transformURL })),
  );
  await transformResults.wait('ready');
  let moving = [];
  await waitFor(async () => (moving = await hostLayers(transformed)).length >= 2, 15000, 200);
  await transformed.waitForTimeout(1500);
  moving = await hostLayers(transformed);
  const movingCovers = await transformed.evaluate(
    () => document.querySelectorAll('canvas[data-bl-cover]').length,
  );
  check(
    `${label}: the pulsating dot and the shrinking disc get host layers with transforms and covers, the box that leaves its clip not`,
    moving.length === 2 && moving.every((layer) => layer.transform) && movingCovers === 2,
    JSON.stringify({ moving, covers: movingCovers }),
  );
  await evalPage(transformed, `document.getElementById('grows').getAnimations()[0].pause()`);
  await transformed.waitForTimeout(300);
  const transformFrames = await framesIn(transformed, 2000);
  check(
    `${label}: no frames while the host scales and fades them`,
    transformFrames <= 4 && transformReferenceFrames >= 40,
    `${transformFrames} frames in 2 s, the reference ${transformReferenceFrames}`,
  );
  // Paused, the disc goes back into the frames where the host showed it (the dot removed first)
  await evalPage(transformed, `document.querySelector('.mw-pulsating-dot').remove()`);
  await waitFor(async () => (await hostLayers(transformed)).length === 1, 5000, 100);
  await transformed.waitForTimeout(300);
  const hosted = await shown(transformed);
  await evalPage(transformed, `document.getElementById('disc').getAnimations()[0].pause()`);
  await waitFor(async () => (await hostLayers(transformed)).length === 0, 5000, 100);
  await transformed.waitForTimeout(500);
  const framed = await shown(transformed);
  // Around the disc (80 CSS pixels at 100, 200, moving by at most 40, 20)
  const region = {
    left: 90 * pixelRatio,
    top: 190 * pixelRatio,
    right: 240 * pixelRatio,
    bottom: 310 * pixelRatio,
  };
  const [a, b] = [shape(hosted, region), shape(framed, region)];
  // The host scales a picture the engine drew at another scale: its edge blurs by about a pixel (a
  // ring of 2 pixels may differ), its place and coverage stay
  const discDifference = compare(hosted, framed, 8);
  const size = 80 * 0.9 * pixelRatio;
  check(
    `${label}: the host layer showed the disc where and as the view shows it`,
    ['left', 'top', 'right', 'bottom'].every((side) => Math.abs(a[side] - b[side]) <= 1) &&
      Math.abs(a.x - b.x) <= 0.25 &&
      Math.abs(a.y - b.y) <= 0.25 &&
      Math.abs(a.area / b.area - 1) <= 0.01 &&
      Math.abs(b.right - b.left + 1 - size) <= 2 &&
      discDifference.pixels <= 2 * Math.PI * size,
    JSON.stringify({ hosted: a, framed: b, size, difference: discDifference }),
  );
  await transformed.close();
}

// The animations of one CSS animation run on one timeline, also when adding them took a while
const keyed = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(keyed);
const keyedResults = collect(keyed);
check('keyframes: page loaded', await openHost(keyed, stack.app({ url: keyframesURL })));
await keyedResults.wait('ready');
let keyedLayers = [];
await waitFor(async () => (keyedLayers = await hostLayers(keyed)).length === 1, 15000, 200);
await keyed.waitForTimeout(300);
const keyedFrames = await framesIn(keyed, 2000);
check(
  'keyframes: a layer whose transform and opacity animations were added far apart gets a host layer and no frames',
  keyedLayers.length === 1 && keyedLayers[0].transform && keyedFrames <= 4,
  `${JSON.stringify(keyedLayers)}, ${keyedFrames} frames in 2 s`,
);
await keyed.close();
await browser.close();
finish();
