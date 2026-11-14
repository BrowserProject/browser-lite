// Intersection observers after scrolls of the user: the wheel scrolls the page and a scroller on
// the compositor's thread, and an observer computes its observations only after something moved
// a target (patch 0137), so it must still see targets these scrolls bring into view and take out.
//
//   node tests/core/intersection-scroll-test.mjs [engine-dir]
import {
  check,
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

const PAGE = `<!doctype html><title>Observed</title>
<style>
  body { margin: 0; height: 4000px }
  #page { position: absolute; top: 1500px; width: 50px; height: 50px; background: blue }
  #scroller { position: absolute; top: 0; left: 400px; width: 300px; height: 200px; overflow: auto }
  #scroller div { height: 2000px; position: relative }
  #inner { position: absolute; top: 1200px; width: 50px; height: 50px; background: green }
</style>
<div id="page"></div>
<div id="scroller"><div><div id="inner"></div></div></div>
<script>
  const seen = { page: [], inner: [] };
  new IntersectionObserver((entries) => {
    for (const entry of entries) {
      seen[entry.target.id].push(entry.isIntersecting ? 1 : 0);
      console.log('RESULT ' + entry.target.id + '=' + seen[entry.target.id].join(''));
    }
  }).observe(document.getElementById('page'));
  new IntersectionObserver((entries) => {
    for (const entry of entries) {
      seen[entry.target.id].push(entry.isIntersecting ? 1 : 0);
      console.log('RESULT ' + entry.target.id + '=' + seen[entry.target.id].join(''));
    }
  }, { root: document.getElementById('scroller') }).observe(document.getElementById('inner'));
  requestAnimationFrame(() => requestAnimationFrame(() => console.log('RESULT ready=1')));
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
const wait = async (key, value, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.get(key) === value) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
check(
  'first observations: both out of view',
  (await wait('page', '0')) && (await wait('inner', '0')),
  `${results.get('page')} ${results.get('inner')}`,
);

const origin = await page.evaluate(() => {
  const rect = document.querySelector('canvas[data-bl-view]').getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});
const wheel = async (x, y, dy, steps) => {
  await page.mouse.move(origin.x + x, origin.y + y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(100);
  }
};

// The page: down to the target, then back up
await wheel(100, 300, 300, 4);
check('wheel down the page: target in view', await wait('page', '01'), results.get('page'));
await wheel(100, 300, -300, 6);
check('wheel back up: target out of view', await wait('page', '010'), results.get('page'));

// The scroller: its own root
await wheel(550, 100, 300, 4);
check('wheel in the scroller: target in its view', await wait('inner', '01'), results.get('inner'));
await wheel(550, 100, -300, 6);
check(
  'wheel back in the scroller: out of its view',
  await wait('inner', '010'),
  results.get('inner'),
);
check('the page target unchanged meanwhile', results.get('page') === '010', results.get('page'));

await browser.close();
finish();
