// Host layers (engine/src/HostLayers.h, packages/core/src/view-host-layers.ts): pulsing
// placeholders, layers that only animate their opacity, get canvases of their own over the view
// canvas once they stand still, and the host runs their opacity; the engine shows no frame for them
// then (with BL_HOST_LAYERS=0 every tick is a frame). A placeholder covered by a later layer stays in
// the frames. What the host layers show at their opacity is what the view shows once the animations
// are paused and the layers are back in the frames. Scrolling puts them back, they come again at the
// new place; a placeholder whose animation ends goes back for good; new contents of a layer go into
// its canvas. At device pixel ratio 1 and 2.
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
// second, and still every frame), one of them under a later layer (#cover)
const BOXES = 6;
const PAGE = `<!doctype html><title>Host layers</title>
<style>
  body { margin: 0; background: #fff; height: 3000px; }
  .box { position: absolute; width: 120px; height: 60px; border-radius: 8px; background: rgb(0, 64, 255);
    animation: fade 60s linear infinite alternate; }
  @keyframes fade { to { opacity: 0.5; } }
  #cover { position: absolute; left: 60px; top: 250px; width: 60px; height: 60px; background: rgb(255, 128, 0);
    will-change: transform; }
</style>
${Array.from({ length: BOXES }, (_, i) => `<div class="box" style="left:${20 + (i % 3) * 160}px;top:${40 + Math.floor(i / 3) * 100}px"></div>`).join('')}
<div class="box" id="covered" style="left:20px;top:240px"></div><div id="cover"></div>
<script>console.log('RESULT ready=1');</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

/** The host layers: key and place in frame pixels. */
const hostLayers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('canvas[data-bl-layer]')].map((canvas) => ({
      key: canvas.getAttribute('data-bl-layer'),
      x: Number.parseFloat(canvas.style.left),
      y: Number.parseFloat(canvas.style.top),
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
      context.globalAlpha = Number(getComputedStyle(over).opacity);
      context.drawImage(
        over,
        Number.parseFloat(over.style.left),
        Number.parseFloat(over.style.top),
      );
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
  await evalPage(reference, `document.getElementById('covered').getAnimations()[0].pause()`);
  await reference.waitForTimeout(300);
  const referenceFrames = await framesIn(reference, 2000);
  const referenceLayers = (await hostLayers(reference)).length;
  await reference.close();

  const page = await open('');
  let layers = [];
  await waitFor(async () => (layers = await hostLayers(page)).length >= BOXES, 15000, 200);
  await page.waitForTimeout(500);
  layers = await hostLayers(page);
  check(
    `${label}: the placeholders get host layers, the covered one not`,
    layers.length === BOXES && referenceLayers === 0,
    `${layers.length} host layers, the reference ${referenceLayers}`,
  );
  // The covered placeholder stays in the frames: paused, nothing else changes them
  await evalPage(page, `document.getElementById('covered').getAnimations()[0].pause()`);
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
  await waitFor(async () => (await hostLayers(page)).length === BOXES, 10000, 200);
  const before = await hostLayers(page);
  // Firefox under Playwright keeps a pixel ratio of 1
  const pixelRatio = await page.evaluate(() => devicePixelRatio);
  await evalPage(page, 'scrollBy(0, 30)');
  let after = [];
  await waitFor(
    async () =>
      (after = await hostLayers(page)).length === BOXES &&
      after.every((layer) => !before.some((old) => old.key === layer.key)),
    10000,
    100,
  );
  const moved =
    after.length === BOXES &&
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
  await waitFor(async () => (await hostLayers(page)).length === BOXES - 1, 5000, 100);
  await page.waitForTimeout(1000);
  check(
    `${label}: a placeholder that stops goes back into the frames`,
    (await hostLayers(page)).length === BOXES - 1,
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
}
await browser.close();
finish();
