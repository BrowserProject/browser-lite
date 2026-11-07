// AVIF images decode (libavif with dav1d, USE_AVIF): the engine sends Safari's user agent, so
// sites that choose the format by user agent (AliExpress) send AVIF. Checks an 8 bit picture, a
// 10 bit one, one with alpha over a blue box, an animated one (red, then green), <picture> with
// an AVIF source, canvas drawImage, and the Accept header of images (image/avif like Safari).
// The fixtures are 160 x 120 with the quadrants red, green, blue, yellow (tests/fixtures/avif-*):
// made with Pillow (8 bit, quality 90; alpha: left half red, right half transparent) and ffmpeg
// with libaom (10 bit: -pix_fmt yuv420p10le -still-picture 1; animated: 2 frames of 0.5 s).
//
//   node tests/core/avif-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  load,
  near,
  openHost,
  pagePixel,
  root,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const RED = [220, 40, 40];
const GREEN = [40, 180, 60];
const BLUE = [40, 60, 200];
const YELLOW = [230, 200, 40];

const fixture = (name) => fs.readFileSync(path.join(root, 'tests/fixtures', `avif-${name}.avif`));
const IMAGES = {
  'quadrants.avif': fixture('quadrants'),
  'tenbit.avif': fixture('tenbit'),
  'alpha.avif': fixture('alpha'),
  'anim.avif': fixture('anim'),
};

// The pictures side by side at their own size; the fallback of <picture> does not exist
const PAGE = `<!doctype html><title>AVIF</title>
<style>body { margin: 0; background: #fff } img, div { position: absolute; top: 0; width: 160px; height: 120px }</style>
<img src="/quadrants.avif" id="quadrants" style="left:0">
<img src="/tenbit.avif" style="left:180px">
<div style="left:360px;background:rgb(40,60,200)"></div>
<img src="/alpha.avif" style="left:360px">
<img src="/anim.avif" style="left:540px">
<picture><source srcset="/quadrants.avif" type="image/avif"><img src="/missing.png" style="left:720px"></picture>
<script>
let pending = document.images.length;
for (const img of document.images)
  img.onload = img.onerror = () => {
    if (--pending) return;
    console.log('RESULT loaded=' + [...document.images].map((i) => i.naturalWidth + 'x' + i.naturalHeight).join(','));
    console.log('RESULT picture=' + document.images[4].currentSrc.split('/').pop());
    const context = Object.assign(document.createElement('canvas'), { width: 160, height: 120 }).getContext('2d');
    context.drawImage(document.getElementById('quadrants'), 0, 0);
    console.log('RESULT canvas=' + [[40, 30], [120, 30], [40, 90], [120, 90]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join('.')).join(','));
  };
</script>`;

const accepts = [];
const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (name === 'blank') {
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<!doctype html><title>blank</title><script>console.log("RESULT blank=1")</script>');
    return;
  }
  if (name.endsWith('.avif') || name.endsWith('.png')) accepts.push(req.headers.accept ?? '');
  if (name === 'missing.png' || name === 'favicon.ico') {
    res.writeHead(404).end();
    return;
  }
  const image = IMAGES[name];
  if (image) {
    res.writeHead(200, { 'Content-Type': 'image/avif' }).end(image);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'avif-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({ viewport: { width: 1000, height: 400 } });
const page = await context.newPage();
const results = collect(page);
const started = await openHost(page, stack.app({ url: `${siteURL}blank` }));
check('host page starts', started && (await results.wait('blank')) === '1');

await load(page, siteURL);
const loaded = await results.wait('loaded');
check(
  'AVIF images decode: 8 bit, 10 bit, alpha, animated, <picture>',
  loaded === '160x120,160x120,160x120,160x120,160x120',
  loaded,
);
const picture = await results.wait('picture');
check('<picture> takes its AVIF source', picture === 'quadrants.avif', picture);

// Where the colors are: quadrants at x 0 and 180 and in <picture> at 720, the alpha picture at
// 360 (red, then the blue box through the transparent half)
const SPOTS = [];
for (const left of [0, 180, 720])
  SPOTS.push(
    [left + 40, 30, RED],
    [left + 120, 30, GREEN],
    [left + 40, 90, BLUE],
    [left + 120, 90, YELLOW],
  );
SPOTS.push([400, 60, RED], [480, 60, BLUE]);
const shown = await waitFor(async () => {
  for (const [x, y, color] of SPOTS)
    if (!near(await pagePixel(page, x, y), color, 30)) return false;
  return true;
}, 30000);
const wrong = [];
for (const [x, y, color] of SPOTS) {
  const pixel = await pagePixel(page, x, y);
  if (!near(pixel, color, 30)) wrong.push(`${x},${y}: ${pixel} instead of ${color}`);
}
check(
  'the pictures show right (8 bit, 10 bit, alpha over the box, <picture>)',
  shown,
  wrong.join('; '),
);

// The animation shows both frames
const seen = new Set();
await waitFor(
  async () => {
    const pixel = await pagePixel(page, 620, 60);
    if (near(pixel, RED, 30)) seen.add('red');
    if (near(pixel, GREEN, 30)) seen.add('green');
    return seen.size === 2;
  },
  10000,
  50,
);
check('the animated AVIF plays (red, then green)', seen.size === 2, [...seen].join(','));

const canvas = (await results.wait('canvas'))?.split(',').map((c) => c.split('.').map(Number));
check(
  'canvas drawImage gets the pixels of the AVIF',
  canvas?.length === 4 &&
    [RED, GREEN, BLUE, YELLOW].every((color, i) => near(canvas[i], color, 30)),
  canvas?.join(' '),
);

check(
  'images are requested with image/avif in Accept, like Safari',
  accepts.length > 0 && accepts.every((accept) => accept.includes('image/avif')),
  [...new Set(accepts)].join(' | '),
);

await browser.close();
finish();
