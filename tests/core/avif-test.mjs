// AVIF images decode (libavif with dav1d, USE_AVIF): the engine sends Safari's user agent, so
// sites that choose the format by user agent (AliExpress) send AVIF. Checks an 8 bit picture, a
// 10 bit one, one with alpha over a blue box, an animated one (red, then green), <picture> with
// an AVIF source, one whose data arrives in two parts (the size is known before the picture
// data), canvas drawImage, and the Accept header of images (image/avif like Safari). Then the
// memory of AVIF images that are never painted: their size comes from the container alone, not
// from a decode of the whole picture, and a memory release does not decode them again (it did,
// and every release raised the memory in use until the engine ran out on vimeo.com).
// The fixtures are 160 x 120 with the quadrants red, green, blue, yellow (tests/fixtures/avif-*):
// made with Pillow (8 bit, quality 90; alpha: left half red, right half transparent; large: the
// quadrants at 2048 x 1536) and ffmpeg with libaom (10 bit: -pix_fmt yuv420p10le -still-picture
// 1; animated: 2 frames of 0.5 s).
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
// The large quadrants with a free box of 1 MB after the picture: every image holds that much
// encoded data, so a decoder that is never freed shows in the memory in use
const LARGE_IMAGES = 40;
const LARGE_PADDING = 1 << 20;
const freeBox = Buffer.alloc(LARGE_PADDING);
freeBox.writeUInt32BE(LARGE_PADDING, 0);
freeBox.write('free', 4, 'latin1');
IMAGES['large.avif'] = Buffer.concat([fixture('large'), freeBox]);
// The meta box of the quadrants ends at byte 267, the picture data follows
const SLOW_SPLIT = 300;

// The pictures side by side at their own size; the fallback of <picture> does not exist
const PAGE = `<!doctype html><title>AVIF</title>
<style>body { margin: 0; background: #fff } img, div { position: absolute; top: 0; width: 160px; height: 120px }</style>
<img src="/quadrants.avif" id="quadrants" style="left:0">
<img src="/tenbit.avif" style="left:180px">
<div style="left:360px;background:rgb(40,60,200)"></div>
<img src="/alpha.avif" style="left:360px">
<img src="/anim.avif" style="left:540px">
<picture><source srcset="/quadrants.avif" type="image/avif"><img src="/missing.png" style="left:720px"></picture>
<img src="/slow.avif" style="left:0;top:140px">
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
  if (name === 'large') {
    // Far below the viewport: never painted, so never decoded
    const images = Array.from(
      { length: LARGE_IMAGES },
      (_, i) => `<img src="/large.avif?n=${i}" style="display:block;margin-top:4000px">`,
    ).join('');
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><title>Large</title><body style="margin:0">${images}<script>
let pending = document.images.length;
for (const img of document.images)
  img.onload = img.onerror = () => {
    if (!--pending)
      console.log('RESULT large=' + [...new Set([...document.images].map((i) => i.naturalWidth + 'x' + i.naturalHeight))]);
  };
window.drop = (name) => {
  for (const img of [...document.images]) {
    img.removeAttribute('src');
    img.remove();
  }
  console.log('RESULT ' + name + '=ok');
};
window.allocate = (name, mb) => {
  (window.keep ??= []).push(new Uint8Array(mb << 20).fill(1));
  console.log('RESULT ' + name + '=ok');
};
</script>`);
    return;
  }
  if (name === 'slow.avif') {
    const image = IMAGES['quadrants.avif'];
    res.writeHead(200, { 'Content-Type': 'image/avif' }).write(image.subarray(0, SLOW_SPLIT));
    setTimeout(() => res.end(image.subarray(SLOW_SPLIT)), 1500);
    return;
  }
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
  'AVIF images decode: 8 bit, 10 bit, alpha, animated, <picture>, in two parts',
  loaded === '160x120,160x120,160x120,160x120,160x120,160x120',
  loaded,
);
const picture = await results.wait('picture');
check('<picture> takes its AVIF source', picture === 'quadrants.avif', picture);

// Where the colors are: quadrants at x 0 and 180 and in <picture> at 720, the alpha picture at
// 360 (red, then the blue box through the transparent half)
const SPOTS = [];
for (const [left, top] of [
  [0, 0],
  [180, 0],
  [720, 0],
  [0, 140],
])
  SPOTS.push(
    [left + 40, top + 30, RED],
    [left + 120, top + 30, GREEN],
    [left + 40, top + 90, BLUE],
    [left + 120, top + 90, YELLOW],
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
  'the pictures show right (8 bit, 10 bit, alpha over the box, <picture>, in two parts)',
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

await page.close();

// Memory of AVIF images that are not painted, with a release from 64 MB of malloc area on: they
// hold their encoded data and the parsed container, not a decoded picture, and once they are gone
// a release frees all of it
const memoryPage = await context.newPage();
const memoryResults = collect(memoryPage);
check(
  'memory: host page starts',
  (await openHost(
    memoryPage,
    stack.app({ url: `${siteURL}blank`, log: '1', env: 'BL_MEMORY_RELEASE_MB=64' }),
  )) && (await memoryResults.wait('blank')) === '1',
);
const usedMB = async () =>
  Math.round((await memoryPage.evaluate(() => window.blTest.browser.debug.memoryUsed())) / 2 ** 20);
const usedBefore = await usedMB();
await load(memoryPage, `${siteURL}large`);
const large = await memoryResults.wait('large');
check(`${LARGE_IMAGES} large AVIF images load`, large === '2048x1536', large);
await memoryPage.waitForTimeout(1000);
const usedLoaded = await usedMB();
// Decoded for their size they took about 7 MB each on top of their data (the dav1d decoder and
// the YUV planes)
const encodedMB = (LARGE_IMAGES * LARGE_PADDING) / 2 ** 20;
check(
  'AVIF images that are not painted take little more than their data',
  usedLoaded - usedBefore < encodedMB + 48,
  `used ${usedBefore} -> ${usedLoaded} MB, ${encodedMB} MB of it encoded data`,
);
await memoryPage.evaluate(() => window.blTest.eval("drop('dropped')"));
await memoryResults.wait('dropped');
// Grow malloc until a release runs; it must not take more memory than it frees (a few MB of noise)
const released = () => memoryResults.logs.filter((line) => line.includes('Memory released'));
const releasedBefore = released().length;
let allocatedMB = 0;
for (let i = 0; i < 6 && released().length === releasedBefore; i++) {
  await memoryPage.evaluate((i) => window.blTest.eval(`allocate('grown${i}', 48)`), i);
  await memoryResults.wait(`grown${i}`);
  allocatedMB += 48;
  await memoryPage.waitForTimeout(300);
}
const releases = released().slice(releasedBefore);
const raised = releases.filter((line) => {
  const [, from, to] = /used (\d+) -> (\d+) MB/.exec(line) ?? [];
  return Number(to) > Number(from) + 8;
});
check(
  'a memory release with AVIF images does not raise the memory in use',
  releases.length > 0 && raised.length === 0,
  releases.join(' | '),
);
// A decoder that was never freed (its reader held it) kept its encoded data
const usedAfter = await usedMB();
check(
  'the release frees the AVIF images that are gone',
  usedAfter - allocatedMB - usedBefore < 24,
  `used ${usedBefore} -> ${usedLoaded} -> ${usedAfter} MB with ${allocatedMB} MB allocated`,
);

await browser.close();
finish();
