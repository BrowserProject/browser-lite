// Fast flings on a long page whose script keeps the engine thread busy in long tasks (like the
// ads of a news site on a phone): the view must not show areas without painted content while it
// moves. The engine learns the scroll position only between those tasks, so the tiles where a
// fling goes are made and painted ahead of it (patch 0097, CoordinatedBackingStoreProxy).
// Unpainted areas show the page background (#305), here magenta, which the content never shows.
//
//   node tests/core/fling-paint-test.mjs [engine-dir]
//   FLING_BUSY / FLING_PERIOD: ms of script every ms (default 400 every 450),
//   FLING_REPORT=1 prints the share of blank pixels per frame of the host
import {
  SWIFTSHADER,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();
if (!chromiumOnly('fling painting (CDP Input.dispatchTouchEvent)')) finish();

const BUSY = Number(process.env.FLING_BUSY ?? 400);
const PERIOD = Number(process.env.FLING_PERIOD ?? 450);
const CARDS = Array.from({ length: 300 }, (_, i) => {
  const hue = 40 + ((i * 37) % 160);
  const words = Array.from({ length: 60 }, (_, w) => `word${(i * 7 + w) % 97}`).join(' ');
  return `<div class="card" style="background: hsl(${hue} 60% 85%)"><h2>Story ${i}</h2><p>${words}</p><p>${words}</p></div>`;
}).join('');
const PAGE = `<!doctype html><title>Fling</title><meta name="viewport" content="width=device-width">
<style>
html { background: rgb(255, 0, 255) } body { margin: 0; font: 15px/1.4 sans-serif }
.card { height: 236px; overflow: hidden; padding: 12px; border-bottom: 4px solid rgb(40, 40, 40);
  border-radius: 6px; box-shadow: inset 0 0 8px rgb(0 0 0 / 30%) }
h2 { margin: 0 0 6px; font-size: 20px }
</style>${CARDS}
<script>
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
if (${BUSY}) setInterval(() => busy(${BUSY}), ${PERIOD});
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
// A phone: narrow, pixel ratio 2, touch
const context = await browser.newContext({
  viewport: { width: 412, height: 800 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
await page.waitForTimeout(3000);

// Share of magenta pixels of the view (and its damage tiles) in every animation frame of the host
await page.evaluate(() => {
  const view = document.querySelector('canvas[data-bl-view]');
  const rect = view.getBoundingClientRect();
  const width = Math.round(rect.width / 4);
  const height = Math.round(rect.height / 4);
  const context = new OffscreenCanvas(width, height).getContext('2d', {
    willReadFrequently: true,
  });
  context.imageSmoothingEnabled = false;
  const sampler = { samples: [], running: true, start: performance.now() };
  window.flingSampler = sampler;
  const tick = () => {
    if (!sampler.running) return;
    context.drawImage(view, 0, 0, width, height);
    for (const tile of document.querySelectorAll('[data-bl-tiles] canvas')) {
      const box = tile.getBoundingClientRect();
      context.drawImage(
        tile,
        (box.left - rect.left) / 4,
        (box.top - rect.top) / 4,
        box.width / 4,
        box.height / 4,
      );
    }
    const data = context.getImageData(0, 0, width, height).data;
    let blank = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i] > 230 && data[i + 1] < 30 && data[i + 2] > 230) blank++;
    sampler.samples.push([performance.now() - sampler.start, blank / (width * height)]);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Like the report from a Pixel 9: four fast swipes up of 500 px in 80 ms, one right after the other
const cdp = await context.newCDPSession(page);
const swipe = async (x, y, dy, ms) => {
  const steps = 5;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + (dy * i) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const flingStart = await page.evaluate(() => performance.now() - window.flingSampler.start);
for (let i = 0; i < 4; i++) {
  await swipe(200, 650, -500, 80);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(3000);
const samples = (
  await page.evaluate(() => {
    window.flingSampler.running = false;
    return window.flingSampler.samples;
  })
).filter(([time]) => time >= flingStart);
await page.evaluate(() =>
  window.blTest.eval("console.log('RESULT scrolled=' + Math.round(scrollY))"),
);
const scrolled = Number(await results.wait('scrolled'));

const mean = samples.reduce((sum, [, blank]) => sum + blank, 0) / Math.max(1, samples.length);
const worst = Math.max(0, ...samples.map(([, blank]) => blank));
// How long the host showed frames with more than a quarter of the view blank
let largeBlankMs = 0;
for (let i = 1; i < samples.length; i++)
  if (samples[i - 1][1] > 0.25) largeBlankMs += samples[i][0] - samples[i - 1][0];
const percent = (share) => `${(share * 100).toFixed(1)} %`;
if (process.env.FLING_REPORT)
  console.log(
    samples
      .map(([time, blank]) => `${Math.round(time - flingStart)}:${Math.round(blank * 100)}`)
      .join(' '),
  );
const summary = `${samples.length} frames, blank on average ${percent(mean)}, at most ${percent(worst)}, over a quarter for ${Math.round(largeBlankMs)} ms`;
console.log(`fling: scrolled ${scrolled} px, ${summary}`);
check('the flings scrolled', scrolled > 2000, `${scrolled} px`);
// Before the tiles were painted ahead: on average 5 to 25 % blank, over a quarter of the view for
// 0.5 to 1.2 s; now none on a quiet machine, a short moment on a loaded one
check('the view shows painted content while it flings', mean < 0.03 && largeBlankMs < 250, summary);
await browser.close();
finish();
