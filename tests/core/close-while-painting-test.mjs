// Views closed while their tiles are still painting. The painting threads of a view run its tile
// jobs (replay, and prepaint for tiles out of view) and tell the view's layer tree host when a tile
// is done. The host goes away with the view, so it must wait for those jobs: a job that ran after
// it called into freed memory ("table index is out of bounds" or "function signature mismatch" on
// a SkiaCPUWorker thread, after closing tabs of heavy sites; here before patch 0113 within the first
// two or three views). Each view keeps repainting tiles in and out of view that take long to paint
// and closes while they paint, and the next view allocates the freed memory. Fewer views in
// Firefox: there each new view of this page takes about 30 s (docs/status.md).
//
//   node tests/core/close-while-painting-test.mjs [engine-dir]
//   PAINT_ROUNDS: views opened and closed (default 10, in Firefox 4)
import {
  BROWSER,
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

const ROUNDS = Number(process.env.PAINT_ROUNDS ?? (BROWSER === 'firefox' ? 4 : 10));
// Layers taller than the view, so every change dirties tiles in view (replay) and out of it
// (prepaint); blurred shadows make every tile slow to paint
const BLOCKS = Array.from({ length: 12 }, (_, i) => {
  const words = Array.from({ length: 400 }, (_, w) => `word${(i * 7 + w) % 97}`).join(' ');
  return `<div class="block"><p>${words}</p></div>`;
}).join('');
const PAGE = `<!doctype html><title>Painting</title>
<style>
body { margin: 0; font: 15px/1.4 sans-serif }
.block { will-change: transform; height: 2400px; padding: 12px; text-shadow: 0 0 12px rgb(0 0 0 / 60%);
  box-shadow: inset 0 0 60px rgb(0 0 120 / 50%) }
</style>${BLOCKS}
<script>
let step = 0;
setInterval(() => {
  step++;
  for (const block of document.querySelectorAll('.block')) block.style.background = 'hsl(' + (step * 13 % 360) + ' 50% 85%)';
}, 50);
console.log('RESULT painting=' + location.search.slice(1));
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const tab = await browser.newPage();
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));

const state = () => tab.evaluate(() => window.blTest.browser?.state ?? 'none').catch(() => 'gone');
const crashed = (value) => value === 'crashed' || value === 'gone';

let opened = 0;
for (let round = 0; round < ROUNDS; round++) {
  results.delete('painting');
  await tab.evaluate((url) => window.blTest.open(url), `${siteURL}?${opened++}`);
  await results.wait('painting', 30000);
  // Painting, then closed while its jobs run
  await tab.waitForTimeout(400 + (round % 4) * 300);
  await tab.evaluate(() => window.blTest.views().at(-1)?.close());
  if (crashed(await state())) break;
}

// Late jobs of the last views and the full GC after closed views (MemoryWatch)
await tab.waitForTimeout(5000);
const last = await state();
check(
  'engine alive after closing painting views',
  !crashed(last),
  `state ${last}, ${opened} views`,
);
if (!crashed(last)) {
  await tab.evaluate(() => window.blTest.eval('console.log("RESULT alive=" + 6 * 7)'));
  check('engine still answers', (await results.wait('alive', 15000)) === '42');
}

await browser.close();
finish();
