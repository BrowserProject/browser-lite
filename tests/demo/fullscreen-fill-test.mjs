// Fullscreen on a host without element fullscreen, like iPhone Safari (no
// Element.prototype.requestFullscreen): the page's fullscreen takes the whole window, the demo's
// bar and everything else of the demo page lie under it, and the page is laid out at the size of
// the window. Esc of the host and the page's own exitFullscreen() end it and put the page area
// back where it was.
//
//   node tests/demo/fullscreen-fill-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  emulateTouchPoints,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const WIDTH = 390;
const HEIGHT = 844;
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>FS</title>
<body style="margin:0">
<button id="fs" style="display:block;width:200px;height:80px;margin:20px">Fullscreen</button>
<script>
document.getElementById('fs').addEventListener('click', () =>
  document.documentElement.requestFullscreen().then(() => console.log('RESULT fs=ok'), (e) => console.log('RESULT fs=' + e.name)));
document.addEventListener('fullscreenchange', () =>
  console.log(document.fullscreenElement ? 'RESULT fson=1' : 'RESULT fsoff=1'));
const size = () => console.log('RESULT size=' + innerWidth + 'x' + innerHeight);
addEventListener('resize', size);
size();
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ app: 'demo', token: 'fsfill-token-0123456789abcdefghij' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  reducedMotion: 'reduce',
});
await emulateTouchPoints(context);
// What iPhone Safari offers: no element fullscreen
await context.addInitScript(() => {
  delete Element.prototype.requestFullscreen;
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

/** The rectangle of the page area and what the host shows in the middle of the demo's bar. */
const layout = () =>
  page.evaluate(() => {
    const pages = document.getElementById('pages');
    const bar = document.getElementById('toolbar').getBoundingClientRect();
    const hit = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    const { left, top, width, height } = pages.getBoundingClientRect();
    return {
      pages: [left, top, width, height].map(Math.round).join(','),
      barCovered: pages.contains(hit),
    };
  });
/** The page's last reported size, once it is `expected` or after 10 s. */
async function pageSize(expected) {
  const end = Date.now() + 10000;
  while (Date.now() < end && results.get('size') !== expected)
    await new Promise((resolve) => setTimeout(resolve, 100));
  return results.get('size');
}

async function enter(label) {
  results.delete('fs');
  results.delete('fson');
  const origin = await canvasOrigin(page);
  await page.touchscreen.tap(origin.x + 120, origin.y + 60);
  check(
    `${label}: the page is fullscreen`,
    (await results.wait('fs')) === 'ok' && (await results.wait('fson')) === '1',
    results.get('fs'),
  );
  const now = await layout();
  check(
    `${label}: the page area fills the window`,
    now.pages === `0,0,${WIDTH},${HEIGHT}`,
    now.pages,
  );
  check(`${label}: the demo's bar lies under it`, now.barCovered);
  const size = await pageSize(`${WIDTH}x${HEIGHT}`);
  check(`${label}: the page has the size of the window`, size === `${WIDTH}x${HEIGHT}`, size);
}

async function left(label, before, sizeBefore) {
  check(`${label}: the page left fullscreen`, (await results.wait('fsoff')) === '1');
  const now = await layout();
  check(
    `${label}: the page area is back`,
    now.pages === before.pages,
    `${before.pages} -> ${now.pages}`,
  );
  check(`${label}: the demo's bar shows again`, !now.barCovered);
  const size = await pageSize(sizeBefore);
  check(`${label}: the page has its old size`, size === sizeBefore, `${sizeBefore} -> ${size}`);
}

await page.goto(stack.app({ url: siteURL }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === '1');
const before = await layout();
const sizeBefore = results.get('size');
check(
  "the demo's bar shows beside the page",
  !before.barCovered && before.pages !== `0,0,${WIDTH},${HEIGHT}`,
  before.pages,
);

await enter('fullscreen button');
results.delete('fsoff');
await page.keyboard.press('Escape');
await left('Esc', before, sizeBefore);

await enter('again');
results.delete('fsoff');
await page.evaluate(() => window.blTest.eval('document.exitFullscreen()'));
await left('exitFullscreen() of the page', before, sizeBefore);

await browser.close();
finish();
