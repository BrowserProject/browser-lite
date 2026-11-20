// Views painted on the CPU (gpu: false, like a browser without WebGL 2) are shown by the
// compositor thread, not by the engine thread (engine/src/Compositor.h): while page script keeps
// the engine thread busy, the browser reads the view canvas at once (a screenshot, drawImage on
// the main thread) and gets the page, and a frame painted right before the busy script is on
// screen meanwhile. Before, the engine worker owned the canvas: Firefox held its main thread for
// 10 s on such a read and then got an empty canvas, and the stalled main thread could not start
// the web workers of new engine threads, so the engine thread waited too (Cloudflare's Turnstile
// took 20 to 40 s per read in a test that looked at the checkbox).
//
//   node tests/core/cpu-frames-test.mjs [engine-dir]
import {
  BROWSER,
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  pagePixel,
  serve,
  shownPixel,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const BUSY_MS = 8000;
const GREEN = [0, 160, 0];
const BLUE = [0, 0, 200];
// paint(color) shows the color; then a task keeps the engine thread busy for BUSY_MS
const PAGE = `<!doctype html><title>CPU frames</title>
<style>html, body { margin: 0; height: 100% } body { background: rgb(${GREEN}) }</style>
<script>
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
window.paintThenBusy = (color) => {
  document.body.style.background = color;
  requestAnimationFrame(() => setTimeout(() => {
    console.log('RESULT busy=1');
    busy(${BUSY_MS});
    console.log('RESULT idle=1');
  }));
};
requestAnimationFrame(() => requestAnimationFrame(() => console.log('RESULT ready=1')));
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'cpu-frames-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
const logs = results.logs;
check('page loaded', await openHost(page, stack.app({ url: siteURL, gpu: '0', log: '1' })));
check('page ready', (await results.wait('ready')) === '1');
check(
  'the compositor thread shows the frames painted on the CPU',
  logs.some((line) => /Compositor: own thread without WebGL 2/.test(line)),
);
let pixel = null;
check(
  'the page shows',
  await waitFor(async () => near((pixel = await shownPixel(page, 400, 300)), GREEN), 10000),
  JSON.stringify(pixel),
);

// A read of the canvas while page script runs: at once, with the page's latest frame
await page.evaluate((color) => window.blTest.eval(`paintThenBusy('${color}')`), `rgb(${BLUE})`);
check('the engine thread is busy', (await results.wait('busy', 10000)) === '1');
await page.waitForTimeout(1000);
let started = Date.now();
pixel = await pagePixel(page, 400, 300);
let ms = Date.now() - started;
check(
  'drawImage of the view canvas while the engine thread is busy: at once, the frame painted before',
  ms < 1000 && near(pixel, BLUE) && !results.get('idle'),
  `${ms} ms, ${JSON.stringify(pixel)}`,
);
started = Date.now();
pixel = await shownPixel(page, 400, 300);
ms = Date.now() - started;
check(
  `${BROWSER === 'chromium' ? 'screenshot pixel' : 'screenshot'} while the engine thread is busy: at once, the page`,
  ms < 2000 && near(pixel, BLUE) && !results.get('idle'),
  `${ms} ms, ${JSON.stringify(pixel)}`,
);
check('the busy script ends', (await results.wait('idle', BUSY_MS + 15000)) === '1');
await browser.close();
finish();
