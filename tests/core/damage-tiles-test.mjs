// Damage tiles (engine/src/DamageTiles.h, packages/core/src/view-tiles.ts): a small animation
// shows only the tiles it touches, in canvases over the view canvas, and the view canvas keeps
// its frame; the host browser then repaints only those tiles instead of the whole view. What the
// tiles show must be what a whole frame shows (0 different pixels, but for a few edge pixels of a
// rotated layer), and a whole frame empties them again. At device pixel ratio 1 and 2; the spinner crosses tile borders.
// Videos the host shows behind the view canvas (VideoOverlay.h) keep the spinner in its tiles when
// they are elsewhere: playing, paused or far below the view. A tile on a video hole shows a whole
// frame instead, also when the video is gone from there.
// Like Safari 18, the engine's workers here keep a canvas's last frame after
// transferFromImageBitmap(null): Safari reads such a canvas back empty but keeps showing the frame,
// so tiles emptied that way showed stale pieces of earlier frames and pages on iPhones.
//
//   node tests/core/damage-tiles-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  recordClip,
  screenPixel,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// A spinner (44 px at 100, 100) crosses the borders of the tiles of 128 CSS pixels at 128. A dot
// that blinks for a while redraws the tile of a still, tilted square at 300, 100.
const PAGE = `<!doctype html><title>Tiles</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  #spinner { position: absolute; left: 100px; top: 100px; width: 36px; height: 36px; border: 4px solid #00f;
    border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #tilted { position: absolute; left: 300px; top: 100px; width: 36px; height: 36px; border: 4px solid #080;
    border-radius: 8px; transform: rotate(33deg); will-change: transform; }
  #dot { position: absolute; left: 350px; top: 100px; width: 6px; height: 6px; background: #f00; }
  p { margin: 200px 20px 0; }
</style>
<div id="spinner"></div><div id="tilted"></div><div id="dot"></div>
<p>${'Static text around a spinner. '.repeat(20)}</p>
<script>
window.blink = (times) => {
  const dot = document.getElementById('dot');
  let left = times;
  const timer = setInterval(() => {
    dot.style.background = left % 2 ? '#0f0' : '#f00';
    if (--left === 0) {
      clearInterval(timer);
      console.log('RESULT blinked=1');
    }
  }, 100);
};
console.log('RESULT ready=1');
</script>`;
// The spinner at 100, 100 again, a playing video at 400, 300 and a paused one at 40, 400, both in
// other tiles, and a playing one far below the view
const VIDEO_PAGE = `<!doctype html><title>Tiles and videos</title>
<style>
  body { margin: 0; background: #fff; }
  #spinner { position: absolute; left: 100px; top: 100px; width: 36px; height: 36px; border: 4px solid #00f;
    border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  video { position: absolute; width: 320px; height: 180px; }
</style>
<div id="spinner" style="z-index:1"></div>
<video id="playing" src="/clip.webm" muted loop playsinline autoplay style="left:400px;top:300px"></video>
<video id="paused" src="/clip.webm" muted preload="auto" style="left:40px;top:400px;width:160px;height:90px"></video>
<video id="below" src="/clip.webm" muted loop playsinline autoplay style="left:40px;top:4000px"></video>
<script>
const playing = document.getElementById('playing');
playing.addEventListener('playing', () => console.log('RESULT playing=1'), { once: true });
</script>`;
let clip = null;
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/clip.webm') {
    serveBytes(req, res, clip, 'video/webm');
    return;
  }
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url === '/video' ? VIDEO_PAGE : PAGE);
});

/**
 * Frame pixels of the view (base64 RGBA) as the host shows them: the view canvas and, with tiles,
 * the tile canvases over it; also how many tile canvases there are.
 */
const shown = (page, withTiles) =>
  page.evaluate((withTiles) => {
    const canvas = document.querySelector('canvas[data-bl-view]');
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const tiles = [...document.querySelectorAll('[data-bl-tiles] canvas')];
    if (withTiles)
      for (const tile of tiles)
        context.drawImage(
          tile,
          Number.parseFloat(tile.style.left),
          Number.parseFloat(tile.style.top),
        );
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000)
      text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return { tiles: tiles.length, width: probe.width, ratio: devicePixelRatio, data: btoa(text) };
  }, withTiles);

// Pixels more than `tolerance` apart in a channel, outside of or (inside) only within a box of
// CSS pixels
const differentPixels = (a, b, { tolerance = 0, box = null, inside = false } = {}) => {
  const x = Buffer.from(a.data, 'base64');
  const y = Buffer.from(b.data, 'base64');
  if (x.length !== y.length) return Number.POSITIVE_INFINITY;
  const ratio = a.ratio;
  let count = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (box) {
      const px = ((i / 4) % a.width) / ratio;
      const py = Math.floor(i / 4 / a.width) / ratio;
      const within = px >= box[0] && py >= box[1] && px < box[2] && py < box[3];
      if (within !== inside) continue;
    }
    for (let c = i; c < i + 3; c++)
      if (Math.abs(x[c] - y[c]) > tolerance) {
        count++;
        break;
      }
  }
  return count;
};
// A tile draws the layers at other device coordinates than the whole view: where the GPU samples
// a scaled or rotated layer it differs by up to 4 levels, and it rounds a few edge pixels of the
// tilted square (with its corners in this box) the other way
const SAMPLING = 4;
const TILTED = [290, 90, 350, 150];

// In a worker of the engine: transferFromImageBitmap(null) keeps the frame shown, as on screen in
// Safari 18, so the readback of the test sees what Safari shows
const keepFrameOnNull = (worker) =>
  worker
    .evaluate(() => {
      const proto = globalThis.ImageBitmapRenderingContext?.prototype;
      if (!proto) return;
      const transfer = proto.transferFromImageBitmap;
      proto.transferFromImageBitmap = function (bitmap) {
        if (bitmap !== null) transfer.call(this, bitmap);
      };
    })
    .catch(() => {});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
for (const ratio of [1, 2]) {
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: ratio,
  });
  page.on('worker', keepFrameOnNull);
  watchErrors(page);
  const results = collect(page);
  check(`ratio ${ratio}: page loaded`, await openHost(page, stack.app({ url: siteURL })));
  await results.wait('ready');

  let tiles = 0;
  await waitFor(async () => (tiles = (await shown(page, false)).tiles) > 0, 15000, 200);
  check(`ratio ${ratio}: the spinner gets tiles`, tiles >= 1 && tiles <= 9, `${tiles} tiles`);

  const viewBefore = await shown(page, false);
  const allBefore = await shown(page, true);
  const turned = await waitFor(
    async () => differentPixels(allBefore, await shown(page, true)) > 0,
    3000,
    200,
  );
  await page.waitForTimeout(300);
  const viewAfter = await shown(page, false);
  check(
    `ratio ${ratio}: the view canvas keeps its frame while the spinner turns`,
    differentPixels(viewBefore, viewAfter) === 0,
    `${differentPixels(viewBefore, viewAfter)} pixels changed`,
  );
  check(`ratio ${ratio}: the tiles show the spinner turning`, turned);

  // The spinner stops; the dot redraws the tile of the tilted square a few times
  await evalPage(page, `document.getElementById('spinner').style.animation = 'none'`);
  await page.waitForTimeout(300);
  results.delete('blinked');
  await evalPage(page, 'blink(6)');
  await results.wait('blinked');
  await page.waitForTimeout(500);
  const fromTiles = await shown(page, true);
  // A change of the whole page shows a whole frame, and the tiles over it are empty
  await evalPage(page, `document.body.style.background = '#eee'`);
  let grey = null;
  await waitFor(
    async () => differentPixels(fromTiles, (grey = await shown(page, false))) > 0,
    5000,
    200,
  );
  await page.waitForTimeout(300);
  grey = await shown(page, false);
  check(
    `ratio ${ratio}: a whole frame empties the tiles`,
    differentPixels(grey, await shown(page, true)) === 0,
    `${differentPixels(grey, await shown(page, true))} pixels of the tiles differ`,
  );
  await evalPage(page, `document.body.style.background = '#fff'`);
  let whole = null;
  const outside = () => differentPixels(whole, fromTiles, { box: TILTED, tolerance: SAMPLING });
  const edges = () =>
    differentPixels(whole, fromTiles, { box: TILTED, inside: true, tolerance: 4 });
  await waitFor(async () => !outside((whole = await shown(page, false))), 5000, 200);
  check(
    `ratio ${ratio}: the tiles showed what a whole frame shows`,
    outside() === 0 && edges() <= 4 * ratio,
    `${outside()} different pixels, ${edges()} edge pixels of the tilted square`,
  );
  check(
    `ratio ${ratio}: the tiles stay empty`,
    differentPixels(whole, await shown(page, true)) === 0,
  );
  await page.close();
}

// Videos in the view (ratio 1)
clip = await recordClip(browser, 3);
{
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  watchErrors(page);
  const results = collect(page);
  check('video: page loaded', await openHost(page, stack.app({ url: `${siteURL}video` })));
  check('video: the video plays', (await results.wait('playing')) === '1');
  const origin = await canvasOrigin(page);
  const screen = (x, y) => screenPixel(page, origin.x + x, origin.y + y);
  const isRed = (p) => p.r > 180 && p.g < 60 && p.b < 60;
  const isWhite = (p) => p.r > 220 && p.g > 220 && p.b > 220;
  let pixel = null;
  await waitFor(async () => isRed((pixel = await screen(560, 390))), 20000, 250);
  check('video: the video shows through its hole', isRed(pixel), JSON.stringify(pixel));

  let viewBefore = null;
  let viewAfter = null;
  // The tiles of the spinner come after the first frames, which place the videos whole
  await waitFor(
    async () => {
      viewBefore = await shown(page, false);
      await page.waitForTimeout(500);
      viewAfter = await shown(page, false);
      return viewAfter.tiles > 0 && differentPixels(viewBefore, viewAfter) === 0;
    },
    10000,
    0,
  );
  const allBefore = await shown(page, true);
  const turned = await waitFor(
    async () => differentPixels(allBefore, await shown(page, true)) > 0,
    3000,
    200,
  );
  check(
    'video: the spinner turns in its tiles, the view canvas keeps its frame',
    turned && differentPixels(viewBefore, viewAfter) === 0,
    `${viewAfter.tiles} tiles, ${differentPixels(viewBefore, viewAfter)} pixels of the view canvas changed in 500 ms`,
  );

  // Over the video the spinner's tiles would show the view canvas's old frame through their hole
  await evalPage(
    page,
    `Object.assign(document.getElementById('spinner').style, { left: '540px', top: '370px' })`,
  );
  await page.waitForTimeout(500);
  const overBefore = await shown(page, false);
  const overChanged = await waitFor(
    async () => differentPixels(overBefore, await shown(page, false)) > 0,
    3000,
    100,
  );
  check('video: over the video the spinner turns in whole frames', overChanged);
  // The clip of 4:3 shows from 440 to 680 in its box of 16:9
  pixel = await screen(470, 320);
  check('video: the video still shows beside the spinner', isRed(pixel), JSON.stringify(pixel));

  // The spinner back in its tiles; the video goes: its hole closes with a whole frame
  await evalPage(
    page,
    `Object.assign(document.getElementById('spinner').style, { left: '100px', top: '100px' })`,
  );
  await page.waitForTimeout(500);
  await evalPage(page, `document.getElementById('playing').style.display = 'none'`);
  await waitFor(async () => isWhite((pixel = await screen(560, 390))), 5000, 200);
  const view = await shown(page, false);
  const offset = (390 * view.width + 560) * 4;
  const rgba = [...Buffer.from(view.data, 'base64').subarray(offset, offset + 4)];
  check(
    'video: where the video was the view canvas shows the page again',
    isWhite(pixel) && rgba.every((value) => value > 220),
    `screen ${JSON.stringify(pixel)}, view canvas ${rgba.join(',')}`,
  );
  await page.close();
}
await browser.close();
finish();
