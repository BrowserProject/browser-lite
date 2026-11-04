// Smooth scrolls the page starts (scrollTo and scrollIntoView with behavior smooth, CSS
// scroll-behavior smooth, an overflow box): the scrolling thread animates them with the
// compositor's ticks (engine/src/ScrollingWasm.cpp), without any wheel event to start them.
//
//   node tests/core/scroll-smooth-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  serve,
  shownPixel,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const BLUE = [0, 0, 255];
// Red on top, blue from 1000 px; an overflow box at the very top
const PAGE = `<!doctype html><title>Smooth</title>
<style>body { margin: 0 } #box { height: 100px; overflow: auto } #top { height: 900px; background: rgb(255, 0, 0) }
#rest { height: 20000px; background: rgb(0, 0, 255) }</style>
<div id="box"><div style="height: 5000px"></div></div><div id="top"></div><div id="rest"><div id="target" style="margin-top: 14000px; height: 10px"></div></div>
<script>
const box = document.getElementById('box');
window.reset = () => {
  document.documentElement.style.scrollBehavior = 'auto';
  scrollTo(0, 0);
  box.scrollTop = 0;
};
// Position right after the call: a smooth scroll starts at the old one
window.start = (code) => {
  new Function(code)();
  console.log('RESULT started=' + Math.round(scrollY) + ',' + box.scrollTop);
};
window.report = () => console.log('RESULT state=' + Math.round(scrollY) + ',' + box.scrollTop);
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
const evalPage = (code) => page.evaluate((code) => window.blTest.eval(code), code);
const state = async () => {
  results.delete('state');
  await evalPage('report()');
  return (await results.wait('state', 20000))?.split(',').map(Number);
};
// The scrolling tree knows the page after its first rendering updates
await page.waitForTimeout(1000);

// [name, script, index of the position (0 page, 1 box), lowest end position]
const cases = [
  ['window.scrollTo', `scrollTo({ top: 15000, behavior: 'smooth' })`, 0, 15000],
  [
    'scrollIntoView',
    `document.getElementById('target').scrollIntoView({ behavior: 'smooth' })`,
    0,
    14000,
  ],
  [
    'CSS scroll-behavior',
    `document.documentElement.style.scrollBehavior = 'smooth'; scrollTo(0, 15000)`,
    0,
    15000,
  ],
  ['overflow box', `box.scrollTo({ top: 3000, behavior: 'smooth' })`, 1, 3000],
];
for (const [name, script, index, end] of cases) {
  await evalPage('reset()');
  await waitFor(async () => (await state())?.every((value) => value === 0), 5000, 200);
  results.delete('started');
  await evalPage(`start(${JSON.stringify(script)})`);
  const started = (await results.wait('started', 20000))?.split(',').map(Number);
  let position = null;
  const arrived = await waitFor(async () => (position = await state())?.[index] >= end, 8000, 200);
  check(
    `${name}: smooth scroll arrives without input`,
    started?.[index] === 0 && arrived,
    `${started} -> ${position}`,
  );
  if (index === 0) {
    // The layers moved on screen too, not only the position the page reads
    const shown = await waitFor(
      async () => near(await shownPixel(page, 400, 300), BLUE),
      5000,
      200,
    );
    check(
      `${name}: the end position shows`,
      shown,
      `pixel ${JSON.stringify(await shownPixel(page, 400, 300))}`,
    );
  }
}
await browser.close();
finish();
