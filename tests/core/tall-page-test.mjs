// A page taller than 2^24 (16,777,216) CSS px with compositing: the content far down gets tiles
// and shows like at the top (patch 0081; the visible rect of a layer was clamped to 2^24 px).
//
//   node tests/core/tall-page-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  evalPage,
  finish,
  launch,
  near,
  openHost,
  pagePixel,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// Colored boxes of 300 px at these page offsets, the page is 20 million px tall
const MARKS = [
  [1_000_000, [255, 0, 0]],
  [16_700_000, [0, 160, 0]],
  [16_800_000, [0, 0, 255]],
  [17_500_000, [255, 160, 0]],
  [19_999_000, [160, 0, 160]],
];
const PAGE = `<!doctype html><title>Tall page</title>
<style>body { margin: 0 } div { position: absolute; left: 0; width: 400px; height: 300px }</style>
<div style="top: 0; height: 20000000px; position: relative"></div>
${MARKS.map(([y, rgb]) => `<div style="top: ${y}px; background: rgb(${rgb})"></div>`).join('\n')}
<script>console.log('RESULT ready=1')</script>`;

const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL, compositing: '1' })));
await results.wait('ready');

for (const [y, rgb] of MARKS) {
  results.delete('scrolled');
  await evalPage(page, `scrollTo(0, ${y}); console.log('RESULT scrolled=' + scrollY)`);
  const scrolled = await results.wait('scrolled');
  let pixel = null;
  await waitFor(async () => near((pixel = await pagePixel(page, 100, 150)), rgb), 10000);
  check(
    `the box at ${y} px shows`,
    near(pixel, rgb),
    `scrollY ${scrolled}, pixel ${JSON.stringify(pixel)}`,
  );
}
await browser.close();
finish();
