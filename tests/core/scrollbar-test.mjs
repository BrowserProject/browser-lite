// Overlay scrollbars and taps (patch 0082): on a mobile device the scrollbars of the page and of a
// scrolling box only show the position and take no hits, so a tap on a button at the right edge
// clicks it and elementFromPoint finds it, like in mobile Chrome and Safari. With a mouse on a
// desktop the scrollbar still takes the press and its thumb can be dragged.
//
//   node tests/core/scrollbar-test.mjs [engine-dir]
import {
  BROWSER,
  canvasOrigin,
  check,
  collect,
  emulateTouchPoints,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// #b at the right edge of the page (fixed, the page scrolls), #c at the right edge of a fixed
// box that scrolls itself (like the modal of a paywall)
const PAGE = `<!doctype html><title>Scrollbar test</title>
<meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; height: 3000px; }
  button { width: 60px; height: 60px; }
  #b { position: fixed; right: 0; top: 10px; }
  #o { position: fixed; left: 0; top: 100px; width: 100%; height: 200px; overflow-y: scroll; background: #eef; }
  #o div { height: 1000px; position: relative; }
  #c { position: absolute; right: 0; top: 10px; }
</style>
<button id="b">B</button><div id="o"><div><button id="c">C</button></div></div>
<script>
  const clicks = { b: 0, c: 0 };
  for (const id of ['b', 'c'])
    document.getElementById(id).addEventListener('click', () => console.log('RESULT click' + id + '=' + ++clicks[id]));
  addEventListener('scroll', () => console.log('RESULT scrolled=' + Math.round(scrollY)));
  console.log('RESULT ready=' + innerWidth);
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'scrollbar-token-0123456789abcdef' });
const browser = await launch();

// Phone: the emulated mobile device (coarse pointer, touch)
const phone = await browser.newContext({
  viewport: { width: 393, height: 700 },
  hasTouch: true,
  ...(BROWSER === 'chromium' ? { isMobile: true } : {}),
});
await emulateTouchPoints(phone);
const page = await phone.newPage();
const results = collect(page);
check(
  'phone: page opens',
  await openHost(page, stack.app({ url: siteURL, device: '393x700x1x1' })),
);
const width = Number(await results.wait('ready'));
check('phone: the page is as wide as the device', width === 393, String(width));
const origin = await canvasOrigin(page);
// Inside the 21 px of the scrollbars, right of the thin thumb and on it
const xs = [width - 18, width - 10, width - 3];
for (const [id, y] of [
  ['b', 40],
  ['c', 140],
]) {
  for (const x of xs) {
    const before = Number(results.get(`click${id}`) ?? 0);
    await page.touchscreen.tap(origin.x + x, origin.y + y);
    const clicked = await waitFor(() => Number(results.get(`click${id}`) ?? 0) > before, 5000);
    check(`phone: a tap at x=${x} clicks #${id} under the scrollbar`, clicked);
  }
}
await evalPage(
  page,
  `console.log('RESULT hits=' + [${xs.map((x) => `document.elementFromPoint(${x}, 40).id, document.elementFromPoint(${x}, 140).id`).join(', ')}].join(','))`,
);
const hits = await results.wait('hits');
check(
  'phone: elementFromPoint finds the buttons under the scrollbars',
  hits === xs.map(() => 'b,c').join(','),
  String(hits),
);
check('phone: the taps did not scroll the page', !results.has('scrolled'), results.get('scrolled'));
await phone.close();

// Desktop: the mouse takes the scrollbar of the page over #b, its thumb drags the page
const desktop = await browser.newPage({ viewport: { width: 800, height: 600 } });
const desktopResults = collect(desktop);
check('desktop: page opens', await openHost(desktop, stack.app({ url: siteURL })));
const desktopWidth = Number(await desktopResults.wait('ready'));
const desktopOrigin = await canvasOrigin(desktop);
const thumbX = desktopOrigin.x + desktopWidth - 5;
await desktop.mouse.move(thumbX, desktopOrigin.y + 40);
await desktop.mouse.down();
await desktop.mouse.move(thumbX, desktopOrigin.y + 90, { steps: 5 });
await desktop.mouse.up();
const scrolled = await desktopResults.wait('scrolled', 10000);
check('desktop: dragging the thumb scrolls the page', Number(scrolled) > 0, String(scrolled));
check(
  'desktop: the press on the scrollbar does not click the button below',
  !desktopResults.has('clickb'),
  String(desktopResults.get('clickb')),
);

await browser.close();
finish();
