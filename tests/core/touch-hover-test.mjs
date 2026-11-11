// Hover after a tap: a scroll hovers nothing new under the old tap point and the page sees no
// mouseover, like in Chrome on Android and Safari on iOS; the tapped link keeps :hover until a
// touch ends. A finger hovers no link for the host either: no link address (view event 'hover'
// with a url) for a tap, a scroll or a swipe, like Chrome on Android; the demo showed the
// address bubble of a tapped link until the next navigation.
// With a mouse a scroll still hovers what comes under the pointer. Before patch 0084 every scroll
// after a tap hovered the element that came under the old tap point (WebCore's fake mouse move).
//
//   node tests/core/touch-hover-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  emulateTouchPoints,
  evalPage,
  finish,
  hostEvents,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const LINKS = Array.from({ length: 40 }, (_, i) => `<a id="l${i}" href="#">Headline ${i}</a>`).join(
  '',
);
const PAGE = `<!doctype html><title>touch hover</title>
<style>
  body { margin: 0; font: 20px sans-serif; }
  a { display: block; height: 100px; color: #036; text-decoration: none; }
  a:hover { text-decoration: underline; background: #ff0; }
</style>
${LINKS}
<script>
  let overs = [];
  document.addEventListener('mouseover', (e) => overs.push(e.target.id || e.target.tagName));
  document.addEventListener('click', (e) => e.preventDefault());
  // The innermost hovered element, the mouseovers since the last report, the element at a point
  window.report = (key, x, y) => {
    const hovered = [...document.querySelectorAll(':hover')].pop();
    const at = document.elementFromPoint(x, y);
    console.log('RESULT ' + key + '=' + [hovered?.id || hovered?.tagName || '', overs.join('+'), at?.id ?? ''].join(','));
    overs = [];
  };
  console.log('RESULT ready=1');
</script>`;

const { url } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'touch-hover-token-0123456789abcd' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 400, height: 700 }, hasTouch: true });
await emulateTouchPoints(context);
const page = await context.newPage();
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url })));
check('page loaded', (await results.wait('ready')) === '1');

const at = async (x, y) => {
  const origin = await canvasOrigin(page);
  return [origin.x + x, origin.y + y];
};
// After WebCore's fake mouse move would have come (0.1 s after a scroll, longer on a slow page)
const report = async (key, [x, y] = [200, 150]) => {
  await page.waitForTimeout(1500);
  results.delete(key);
  await evalPage(page, `report('${key}', ${x}, ${y})`);
  const [hovered, overs, under] = String(await results.wait(key, 10000)).split(',');
  return { hovered, overs, under };
};

// The link addresses the host was told about (view event 'hover')
const hoveredLinks = async () =>
  (await hostEvents(page)).filter((e) => e.startsWith('hover:') && e !== 'hover:');

await page.touchscreen.tap(...(await at(200, 150)));
const tapped = await report('tapped');
check('tap hovers the tapped link', tapped.hovered === 'l1', JSON.stringify(tapped));

await evalPage(page, 'scrollBy(0, 330)');
const scrolled = await report('scrolled');
check(
  'scroll after a tap: the tapped link stays hovered, no mouseover',
  scrolled.hovered === 'l1' && scrolled.overs === '' && scrolled.under !== 'l1',
  JSON.stringify(scrolled),
);

if (chromiumOnly('swipe after a tap (CDP Input.dispatchTouchEvent)')) {
  const cdp = await context.newCDPSession(page);
  const [x, y] = await at(200, 500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - i * 20 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // WebKit's touch release takes :hover and :active from the page, a scroll hovers nothing new
  const swiped = await report('swiped');
  check(
    'swipe after a tap: nothing hovered, no mouseover',
    swiped.hovered === '' && swiped.overs === '',
    JSON.stringify(swiped),
  );
}

check(
  'touch shows no link address',
  (await hoveredLinks()).length === 0,
  String(await hoveredLinks()),
);

// A mouse: the scroll hovers what comes under the pointer
await page.mouse.move(...(await at(200, 150)), { steps: 3 });
const moved = await report('moved');
check('mouse hovers the link under it', moved.hovered === moved.under, JSON.stringify(moved));
check(
  'mouse shows the link address',
  (await hoveredLinks()).at(-1) === `hover:${url}#`,
  String(await hoveredLinks()),
);
await evalPage(page, 'scrollBy(0, 330)');
const mouseScrolled = await report('mousescrolled');
check(
  'scroll under the mouse: the link now under it is hovered, with mouseover',
  mouseScrolled.hovered === mouseScrolled.under &&
    mouseScrolled.hovered !== moved.hovered &&
    mouseScrolled.overs.split('+').includes(mouseScrolled.under),
  JSON.stringify(mouseScrolled),
);

await browser.close();
finish();
