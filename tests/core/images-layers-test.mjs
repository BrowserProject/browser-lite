// Images shown as the contents of a compositing layer keep their decoded frame (patch 0086):
// six still 2000 x 2000 WebP images with `will-change: transform` below the fold (96 MB decoded,
// more than the memory cache's 64 MB) while a small image moves every frame. The move repaints
// the small image, which lets the memory cache prune the decoded data of images not drawn in the
// last second, and makes every compositing layer update its configuration, which takes the
// current frame of a layer's image. Before, the pruning dropped the frames the layers still showed
// and every frame decoded all six images again on the engine thread (about a second per frame).
//
//   node tests/core/images-layers-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const SIZE = 2000;
const COUNT = 6;

// A still lossy WebP with detail everywhere, so that decoding it costs what a photo costs
function drawPicture([size, seed]) {
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  let state = seed;
  for (let i = 0; i < image.data.length; i += 4) {
    state = (state * 1103515245 + 12345) >>> 0;
    const x = (i / 4) % size;
    image.data[i] = (x + (state >>> 24)) & 255;
    image.data[i + 1] = (state >>> 16) & 255;
    image.data[i + 2] = ((i >> 12) + (state >>> 8)) & 255;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return new Promise((resolve) =>
    canvas.toBlob(
      (blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      },
      'image/webp',
      0.8,
    ),
  );
}

const browser = await launch({ args: SWIFTSHADER });
const maker = await browser.newPage();
const pictures = [];
for (let i = 0; i < COUNT; i++)
  pictures.push(Buffer.from(await maker.evaluate(drawPicture, [SIZE, i + 1]), 'base64'));
await maker.close();

// The layers sit below the fold (images in view keep their frame anyway, MemoryCache asks their
// renderers). animate() counts the animation frames of 4 s while the small image moves.
const PAGE = `<!doctype html><title>Layers</title>
<style>
body { margin: 0; height: 9000px }
.layer { position: absolute; top: 3000px; width: 300px; height: 300px; will-change: transform }
#mover { position: absolute; top: 20px; left: 0 }
</style>
<div id="mover"><img src="/small.webp" width="64" height="64"></div>
${pictures.map((_, i) => `<img class="layer" src="/big-${i}.webp" style="left:${i * 310}px">`).join('\n')}
<script>
let pending = document.images.length;
for (const img of document.images)
  img.onload = () => {
    if (!--pending) console.log('RESULT loaded=' + document.images.length);
  };
window.animate = () => {
  const mover = document.getElementById('mover');
  const start = performance.now();
  let frames = 0;
  let longest = 0;
  let last = start;
  const step = (now) => {
    frames++;
    longest = Math.max(longest, now - last);
    last = now;
    mover.style.left = (frames % 400) + 'px';
    if (now - start < 4000) requestAnimationFrame(step);
    else console.log('RESULT frames=' + frames + ',' + Math.round(longest));
  };
  requestAnimationFrame(step);
};
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  const big = /^big-(\d)\.webp$/.exec(name);
  if (big || name === 'small.webp') {
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=600' });
    res.end(big ? pictures[Number(big[1])] : pictures[0]);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'images-layers-token-0123456789abcdef' });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: siteURL })));
check('the page and its images load', (await results.wait('loaded', 60000)) === String(COUNT + 1));
// Let the first decoding of every layer image and its upload settle
await page.waitForTimeout(3000);

await page.evaluate(() => window.blTest.eval('animate()'));
const [frames, longest] = ((await results.wait('frames', 60000)) ?? '0,0').split(',').map(Number);
check(
  'the layers keep their decoded images: the page animates while the small image moves',
  frames >= 40 && longest < 1000,
  `${frames} frames in 4 s, longest ${longest} ms`,
);

await browser.close();
finish();
