// Lazy fonts of other scripts (#255 in docs/decisions.md, setLazyWaitLimit in
// engine/src/LazyFiles.cpp): a page whose text needs one that is still on the way does not wait
// for it longer than the wait limit; once the font arrives, the text is laid out again with it.
//
//   node tests/core/fonts-test.mjs [engine-dir]
import {
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

// Thai: not in the fonts of engine.data, from lazy/fonts/scripts. The width of the text tells
// which font it has.
const PAGE = `<!doctype html><title>Thai</title><body style="margin:20px">
<span id="text" style="font:40px sans-serif">สวัสดีครับ</span>
<script>
const text = document.getElementById('text');
const first = text.getBoundingClientRect().width;
console.log('RESULT first=' + first);
const timer = setInterval(() => {
  const width = text.getBoundingClientRect().width;
  if (width !== first) {
    clearInterval(timer);
    console.log('RESULT laidout=' + width);
  }
}, 100);
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

// The Thai font: every request waits until released
const HOLD_MS = 5000;
let requests = 0;
let releasedAt = 0;
let startRelease = () => {};
const release = new Promise((resolve) => {
  startRelease = () => setTimeout(resolve, HOLD_MS);
}).then(() => {
  releasedAt = Date.now();
});
// Held from the first request on
await context.route('**/lazy/fonts/scripts/NotoSansThai-*', async (route) => {
  if (++requests === 1) startRelease();
  await release;
  await route.continue();
});

check('browser starts', await openHost(page, stack.app({ url: siteURL })));
const first = await results.wait('first', HOLD_MS + 10000);
check('the text is laid out while its font is held back', first !== null && !releasedAt, first);
check('the font was requested', requests >= 1, `${requests} requests`);
// Playwright holds back the synchronous request of the engine thread only in Chromium: in Firefox
// the font is there at once
if (chromiumOnly('relayout once the font is there (route of a synchronous request)')) {
  const laidOut = await results.wait('laidout', 20000);
  check(
    'once the font is there the text is laid out again with it',
    laidOut !== null && releasedAt > 0,
    `${first} -> ${laidOut}`,
  );
}

await browser.close();
finish();
