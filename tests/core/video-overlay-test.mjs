// Video overlay (#232): with compositing the host shows its own <video> behind the view canvas,
// where the engine's compositor punched a hole into the page. Checked with screenshots of the host
// page (what Chromium really shows): the video appears through the hole, page content above the
// video stays above it, no frames are copied into the engine, requestVideoFrameCallback and
// canvas.drawImage(video) still work (frames only on demand), the video follows scrolling, and a
// video with opacity falls back to frames painted into the page, and a video hidden and shown
// again gets its hole back.
//
//   node tests/core/video-overlay-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
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
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const browser = await launch();
// WebM: 3 s, the canvas always red
const CLIP = await recordClip(browser, 3);

const PAGE = `<!doctype html><title>Overlay test</title><body style="margin:0;background:#fff;height:3000px">
<video id="video" src="/clip.webm" muted loop playsinline autoplay style="position:absolute;left:40px;top:40px;width:320px;height:240px"></video>
<div style="position:absolute;left:150px;top:130px;width:40px;height:40px;background:rgb(0,0,255)"></div>
<video id="faded" src="/clip.webm" muted loop playsinline autoplay style="position:absolute;left:420px;top:40px;width:320px;height:240px;opacity:0.5"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
video.addEventListener('playing', () => result('playing', '1'), { once: true });
const seen = [];
const onFrame = (now, metadata) => {
  seen.push(metadata.presentedFrames);
  if (seen.length < 3)
    return video.requestVideoFrameCallback(onFrame);
  result('rvfc', seen[0] < seen[1] && seen[1] < seen[2] ? 'ok' : seen.join('/'));
};
video.requestVideoFrameCallback(onFrame);
// canvas.drawImage(video): the first reads find no frame yet, the host copies some on demand
const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 240;
const context = canvas.getContext('2d');
const draw = setInterval(() => {
  if (video.readyState < 2)
    return;
  context.drawImage(video, 0, 0, 320, 240);
  const [r, g, b] = context.getImageData(160, 120, 1, 1).data;
  if (r > 180 && g < 60 && b < 60) {
    clearInterval(draw);
    result('draw', r + ',' + g + ',' + b);
  }
}, 200);
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }
  if (req.url === '/clip.webm') {
    serveBytes(req, res, CLIP, 'video/webm');
    return;
  }
  res.writeHead(404).end();
});

const stack = await startStack();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key, timeout = TIMEOUT) => results.wait(key, timeout);

const isRed = (p) => !!p && p.r > 180 && p.g < 60 && p.b < 60;
const isBlue = (p) => !!p && p.b > 180 && p.r < 60 && p.g < 60;
const isWhite = (p) => !!p && p.r > 220 && p.g > 220 && p.b > 220;
// Half transparent red on white
const isPink = (p) => !!p && p.r > 200 && p.g > 80 && p.g < 190 && p.b > 80 && p.b < 190;

/** Pixel of the host page at x, y of the view until test(pixel) holds (at most 20 s). */
async function waitForScreen(x, y, test) {
  const origin = await canvasOrigin(page);
  let pixel = null;
  await waitFor(
    async () => test((pixel = await screenPixel(page, origin.x + x, origin.y + y))),
    20000,
    250,
  );
  return pixel;
}

const players = () => page.evaluate(() => window.blTest.mediaState());

await openHost(page, stack.app({ url: siteURL }));
check('video plays', (await result('playing')) === '1');

const shown = await waitForScreen(250, 100, isRed);
check('video shows through the hole in the page', isRed(shown), JSON.stringify(shown));
const behind = await page.evaluate(() => {
  const video = [...document.querySelectorAll('video')].find((v) =>
    v.nextElementSibling?.matches('canvas[data-bl-view]'),
  );
  return video
    ? `${video.style.transform.startsWith('matrix(')}:${getComputedStyle(video).position}`
    : 'none';
});
check('the host <video> lies behind the view canvas', behind === 'true:absolute', behind);
const cover = await waitForScreen(170, 150, isBlue);
check('page content above the video stays above it', isBlue(cover), JSON.stringify(cover));

const faded = await waitForScreen(580, 160, isPink);
check(
  'a video with opacity falls back to frames painted into the page',
  isPink(faded),
  JSON.stringify(faded),
);

check('requestVideoFrameCallback', (await result('rvfc')) === 'ok', results.get('rvfc'));
const drawn = (await result('draw')) || '';
const [r, g, b] = drawn.split(',').map(Number);
check('canvas.drawImage(video) gets frames on demand', isRed({ r, g, b }), drawn);

// The drawImage reads stopped: after their 2 s the overlay player copies no frames anymore,
// the faded one (frames painted into the page) copies all
await page.waitForTimeout(3000);
const before = (await players()).map((p) => p.frames).sort((x, y) => x - y);
await page.waitForTimeout(2000);
const after = (await players()).map((p) => p.frames).sort((x, y) => x - y);
check(
  'no frames copied for the overlay, all for the fallback',
  before.length === 2 && after[0] - before[0] <= 2 && after[1] - before[1] > 10,
  `${before.join('/')} -> ${after.join('/')}`,
);

// Hidden and shown again (YouTube does that around its consent dialog): WebCore makes a new
// layer for the video, which must get the hole again (patch 0048)
await page.evaluate(() =>
  window.blTest.eval("document.getElementById('video').style.display = 'none'"),
);
await waitForScreen(250, 100, isWhite);
await page.evaluate(() =>
  window.blTest.eval("document.getElementById('video').style.display = ''"),
);
const again = await waitForScreen(250, 100, isRed);
check(
  'hidden and shown again, the video shows through the hole',
  isRed(again),
  JSON.stringify(again),
);

// Scrolling: the video moves up with the page, the hole and the host video together
await page.evaluate(() => window.blTest.eval('scrollTo(0, 100)'));
const scrolled = await waitForScreen(250, 30, isRed);
check('the video follows scrolling', isRed(scrolled), JSON.stringify(scrolled));
const below = await waitForScreen(250, 200, isWhite);
check('below the scrolled video the page shows again', isWhite(below), JSON.stringify(below));

await browser.close();
finish();
