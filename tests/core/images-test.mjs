// Images drawn small decode small (patch 0054, #270): a 4000 x 3000 JPEG shown at 400 x 300
// decodes at 1/8 in the DCT instead of taking 48 MB at full size, a WebP of the same size at
// 200 x 150 decodes scaled by libwebp (patch 0058, #286), and the pictures match the
// full decoding (BL_IMAGE_SUBSAMPLING=0) at the shown size. Drawn larger later (page zoom, pinch
// zoom) it decodes again and its fine stripes come out sharp; canvas drawImage at full size gets
// every pixel. A progressive JPEG and one with EXIF orientation arrive in slow pieces (partial
// decoding) and show correctly. tests/fixtures/progressive.jpg: 1600 x 1200, the quadrants and
// stripes below, saved with Pillow (quality 85, progressive).
//
//   node tests/core/images-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  chromiumOnly,
  SWIFTSHADER,
  canvasOrigin,
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

const MB = 2 ** 20;
const RED = [220, 40, 40];
const GREEN = [40, 180, 60];
const BLUE = [40, 60, 200];
const YELLOW = [230, 200, 40];

// Quadrants red, green, blue, yellow; in the top left corner (a quarter wide, an eighth high)
// vertical stripes 4 px black, 4 px white: too fine for a decoding at 1/8, sharp at 1/2
function drawPicture([width, height, stripes, type]) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const fill = (color, x, y, w, h) => {
    context.fillStyle = `rgb(${color})`;
    context.fillRect(x, y, w, h);
  };
  fill('220,40,40', 0, 0, width / 2, height / 2);
  fill('40,180,60', width / 2, 0, width / 2, height / 2);
  fill('40,60,200', 0, height / 2, width / 2, height / 2);
  fill('230,200,40', width / 2, height / 2, width / 2, height / 2);
  if (stripes)
    for (let x = 0; x < width / 4; x += 8) {
      fill('0,0,0', x, 0, 4, height / 8);
      fill('255,255,255', x + 4, 0, 4, height / 8);
    }
  return new Promise((resolve) =>
    canvas.toBlob(
      (blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      },
      type,
      0.9,
    ),
  );
}

// EXIF (APP1) with only the orientation, right after the start of the JPEG
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.from([
    // big endian, first IFD at 8, one entry: orientation, SHORT, 1 value; no next IFD
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const size = payload.length + 2;
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1, size >> 8, size & 0xff]),
    payload,
    jpeg.subarray(2),
  ]);
}

const browser = await launch({ args: SWIFTSHADER });
const maker = await browser.newPage();
const picture = async (width, height, stripes, type = 'image/jpeg') =>
  Buffer.from(await maker.evaluate(drawPicture, [width, height, stripes, type]), 'base64');
const IMAGES = {
  'photo.jpg': await picture(4000, 3000, true),
  // Stored 2000 x 1000, shown turned a quarter clockwise (1000 x 2000)
  'exif.jpg': withOrientation(await picture(2000, 1000, false), 6),
  'photo.webp': await picture(4000, 3000, true, 'image/webp'),
  'progressive.jpg': fs.readFileSync(path.join(root, 'tests/fixtures/progressive.jpg')),
};
await maker.close();

// The photo at 400 x 300, the progressive image at 200 x 150 (x 420), the turned one 100 x 200
// (x 640), the WebP at 200 x 150 (x 760). canvasRow() draws the photo at full size into a canvas and reports the first stripes;
// decodeTime() draws a fresh copy of the photo small into a canvas (a synchronous decoding).
const PAGE = `<!doctype html><title>Images</title>
<style>body { margin: 0; background: #fff } img { position: absolute; top: 0 }</style>
<img id="photo" src="/photo.jpg" style="left:0;width:400px;height:300px">
<img src="/progressive.jpg" style="left:420px;width:200px;height:150px">
<img src="/exif.jpg" style="left:640px;width:100px">
<img src="/photo.webp" style="left:760px;width:200px;height:150px">
<script>
let pending = document.images.length;
for (const img of document.images)
  img.onload = () => {
    if (!--pending) console.log('RESULT loaded=' + [...document.images].map((i) => i.naturalWidth + 'x' + i.naturalHeight).join(','));
  };
window.canvasRow = () => {
  const img = document.getElementById('photo');
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(img, 0, 0);
  const data = context.getImageData(0, 10, 64, 1).data;
  const row = [];
  for (let i = 0; i < data.length; i += 4) row.push(data[i]);
  console.log('RESULT canvas=' + row.join(','));
};
window.decodeTime = () => {
  const img = new Image();
  img.onload = () => {
    const context = Object.assign(document.createElement('canvas'), { width: 400, height: 300 }).getContext('2d');
    const start = performance.now();
    context.drawImage(img, 0, 0, 400, 300);
    context.getImageData(0, 0, 1, 1);
    console.log('RESULT decodeMs=' + Math.round(performance.now() - start));
  };
  img.src = '/photo.jpg?fresh';
};
</script>`;

// The JPEGs of exif and progressive arrive in four pieces 250 ms apart
const { url: siteURL } = await serve((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (name === 'blank') {
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<!doctype html><title>blank</title><script>console.log("RESULT blank=1")</script>');
    return;
  }
  const image = IMAGES[name];
  if (!image) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }
  const type = name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (name.startsWith('photo.')) {
    res.end(image);
    return;
  }
  const piece = Math.ceil(image.length / 4);
  let offset = 0;
  const next = () => {
    res.write(image.subarray(offset, offset + piece));
    offset += piece;
    if (offset < image.length) setTimeout(next, 250);
    else res.end();
  };
  next();
});

const stack = await startStack({ token: 'images-token-0123456789abcdef' });

// Where the colors of the three pictures are, at zoom 1
const SPOTS = [
  [300, 75, GREEN],
  [100, 225, BLUE],
  [300, 225, YELLOW],
  [150, 50, RED],
  [470, 110, BLUE],
  [570, 40, GREEN],
  [665, 50, BLUE],
  [715, 50, RED],
  [665, 150, YELLOW],
  [715, 150, GREEN],
  [790, 60, RED],
  [910, 40, GREEN],
  [810, 110, BLUE],
  [910, 110, YELLOW],
];
// Rows of the pictures compared between both runs: [y, from x, to x]
const ROWS = [
  [75, 0, 400],
  [150, 0, 400],
  [225, 0, 400],
  [40, 420, 620],
  [110, 420, 620],
  [50, 640, 740],
  [100, 640, 740],
  [150, 640, 740],
  [40, 760, 960],
  [110, 760, 960],
];
const luma = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
// Contrast of the stripes: spread of the brightness along a row
const contrast = (row) => {
  const values = row.map(luma);
  return Math.round(Math.max(...values) - Math.min(...values));
};

// One engine with env; returns what the comparison needs
async function run(env) {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const results = collect(page);
  const label = env || 'default';
  const started = await openHost(
    page,
    stack.app({ url: `${siteURL}blank`, ...(env ? { env } : {}) }),
  );
  check(`${label}: host page starts`, started && (await results.wait('blank')) === '1');
  const used = () => page.evaluate(() => window.blTest.browser.debug.memoryUsed());
  const before = await used();

  await load(page, siteURL);
  const loaded = await results.wait('loaded');
  const shown = await waitFor(async () => {
    for (const [x, y, color] of SPOTS)
      if (!near(await pagePixel(page, x, y), color, 30)) return false;
    return true;
  }, 30000);
  const missing = [];
  for (const [x, y, color] of SPOTS) {
    const pixel = await pagePixel(page, x, y);
    if (!near(pixel, color, 30)) missing.push(`${x},${y}: ${pixel} instead of ${color}`);
  }
  check(
    `${label}: the pictures show right (quadrants, EXIF orientation, progressive in pieces, WebP)`,
    loaded === '4000x3000,1600x1200,1000x2000,4000x3000' && shown,
    `${loaded} ${missing.join('; ')}`,
  );
  await page.waitForTimeout(500);
  const memory = (await used()) - before;
  const rows = [];
  for (const [y, from, to] of ROWS)
    rows.push((await page.evaluate((y) => window.blTest.pageRow(y), y)).slice(from, to));

  const value = async (key, source) => {
    await page.evaluate((source) => window.blTest.eval(source), source);
    return results.wait(key, 30000);
  };
  const decodeMs = Number(await value('decodeMs', 'decodeTime()'));
  return { page, context, results, memory, rows, decodeMs, value };
}

// 1) Default: decoded small
const small = await run('');
const { page } = small;
check(
  'the photos shown at 400 x 300 (JPEG) and 200 x 150 (WebP) take little memory',
  small.memory < 16 * MB,
  `${(small.memory / MB).toFixed(1)} MB more than the blank page`,
);

// 2) Touchpad pinch to 4 at the top left corner: the compositor scales the tiles of the photo
// decoded at 1/8 (gray stripes), then the engine paints them again at the new scale and decodes
// the photo at 1/2 (sharp stripes)
const stripesRow = async (y) =>
  (await page.evaluate((y) => window.blTest.pageRow(y), y)).slice(8, 360);
// The pinch gesture comes from CDP
if (chromiumOnly('pinch zoom 4 decodes the photo again (CDP pinch gesture)')) {
  const smallSpread = contrast(await stripesRow(20));
  const cdp = await small.context.newCDPSession(page);
  const origin = await canvasOrigin(page);
  await cdp.send('Input.synthesizePinchGesture', {
    x: origin.x + 1,
    y: origin.y + 1,
    scaleFactor: 4,
    relativeSpeed: 3000,
    gestureSourceType: 'mouse',
  });
  let pinched = 0;
  const pinchSharp = await waitFor(async () => {
    pinched = contrast(await stripesRow(60));
    return pinched > 120;
  }, 20000);
  check(
    'pinch zoom 4 decodes the photo again: sharp stripes',
    smallSpread < 80 && pinchSharp,
    `brightness spread ${smallSpread} at 400 x 300, ${pinched} after the pinch`,
  );
}

// 3) The page again (scale 1, decoded at 1/8), then page zoom 4: the photo is 1600 x 1200
small.results.delete('loaded');
await load(page, siteURL);
await small.results.wait('loaded');
await waitFor(async () => near(await pagePixel(page, 300, 225), YELLOW, 30), 20000);
await page.evaluate(() => window.blTest.view().setZoom(4));
let zoomed = 0;
const sharp = await waitFor(async () => {
  zoomed = contrast(await stripesRow(60));
  return zoomed > 120;
}, 20000);
check('page zoom 4 decodes the photo again: sharp stripes', sharp, `brightness spread ${zoomed}`);

// 4) canvas drawImage at full size: the stripes of 4 px at full resolution
const canvasRow = (await small.value('canvas', 'canvasRow()'))?.split(',').map(Number) ?? [];
const stripesExact =
  canvasRow.length === 64 &&
  canvasRow.every((v, x) =>
    x % 8 === 0 || x % 8 === 3 || x % 8 === 4 || x % 8 === 7 ? true : x % 8 < 4 ? v < 60 : v > 195,
  );
check('canvas drawImage at full size gets every pixel', stripesExact, canvasRow.join(','));
await small.context.close();

// 5) Reference: every image decoded at full size
const full = await run('BL_IMAGE_SUBSAMPLING=0');
await full.context.close();
check(
  'decoded at full size the same photos take about 96 MB more',
  full.memory > 80 * MB,
  `${(full.memory / MB).toFixed(1)} MB more than the blank page`,
);
// Mean difference per channel of the shown pictures
let sum = 0;
let count = 0;
small.rows.forEach((row, i) =>
  row.forEach((pixel, x) => {
    for (let c = 0; c < 3; c++) sum += Math.abs(pixel[c] - full.rows[i][x][c]);
    count += 3;
  }),
);
const difference = sum / count;
check(
  'the pictures look like the full decoding at the shown size',
  difference < 6,
  `mean difference ${difference.toFixed(2)} per channel over ${count / 3} pixels`,
);
console.log(
  `   decoding into a 400 x 300 canvas: ${small.decodeMs} ms small, ${full.decodeMs} ms at full size`,
);

await browser.close();
finish();
