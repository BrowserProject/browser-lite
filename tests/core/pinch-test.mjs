// Pinch zoom like Chrome (engine/src/PinchZoom.h): touchpad (Ctrl + wheel, through CDP
// Input.synthesizePinchGesture) and two fingers only scale the view. The compositor thread shows
// the gesture right away, even when the JS of the page blocks the engine thread; afterwards the
// page knows the new scale (visualViewport with a resize event), the layout keeps its width.
// Click and wheel right after the gesture are not lost and hit what is shown. touch-action: none
// and preventDefault of the page prevent zooming, Ctrl + mouse wheel stays page zoom (the zoom
// of the view). Ctrl + wheel goes to the page first: when a wheel listener calls preventDefault
// (like maps), only the page zooms, also in an iframe (embedded map); without a blocking
// listener at that place the view zooms right away. A new page starts at 1 (back restores it).
// Without the compositor (compositing: false) the engine thread scales.
//
//   node tests/core/pinch-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  load,
  near,
  openHost,
  pagePixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// Red box 100..200, green 250..300 (top left), a blue box with touch-action: none, a gray one
// with a touchmove listener that wants two fingers itself and a wheel listener without
// preventDefault. The "map" (orange) zooms itself with Ctrl + wheel, so does the embedded map in
// the iframe (yellow, listener on its document), the document reads Ctrl + wheel passively. The
// bar #wide is as wide as the layout.
const PAGE = `<!doctype html><title>Pinch test</title>
<style>
  body { margin: 0; background: #fff; height: 2000px; }
  #wide { height: 20px; background: rgb(200, 200, 200); }
  .box { position: absolute; }
</style>
<div id="wide"></div>
<div id="red" class="box" style="left:100px;top:100px;width:100px;height:100px;background:rgb(255,0,0)"></div>
<div class="box" style="left:250px;top:100px;width:50px;height:50px;background:rgb(0,160,0)"></div>
<div class="box" style="left:100px;top:400px;width:100px;height:100px;background:rgb(255,0,255)"></div>
<div id="nozoom" class="box" style="left:500px;top:300px;width:400px;height:300px;background:rgb(0,0,255);touch-action:none"></div>
<div id="grab" class="box" style="left:500px;top:50px;width:400px;height:200px;background:rgb(120,120,120)"></div>
<div id="map" class="box" style="left:250px;top:550px;width:150px;height:100px;background:rgb(255,160,0)"></div>
<iframe src="/frame" class="box" style="left:50px;top:550px;width:150px;height:100px;border:0"></iframe>
<script>
let resizes = 0;
visualViewport.addEventListener('resize', () => console.log('RESULT vvresize=' + ++resizes));
document.getElementById('red').addEventListener('click', (e) => console.log('RESULT redclick=' + Math.round(e.pageX) + ',' + Math.round(e.pageY)));
document.getElementById('grab').addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    console.log('RESULT grabbed=1');
  }
}, { passive: false });
let grabWheels = 0;
document.getElementById('grab').addEventListener('wheel', (e) => {
  if (e.ctrlKey && !grabWheels++)
    console.log('RESULT grabcancelable=' + e.cancelable);
  else if (e.ctrlKey && !e.cancelable)
    console.log('RESULT grabpassive=1');
}, { passive: false });
let mapZooms = 0;
document.getElementById('map').addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    console.log('RESULT mapzoom=' + ++mapZooms);
  }
}, { passive: false });
let ctrlWheels = 0;
document.addEventListener('wheel', (e) => e.ctrlKey && console.log('RESULT ctrlwheel=' + ++ctrlWheels), { passive: true });
console.log('RESULT ready=1');
</script>`;

const FRAME = `<!doctype html><style>body { margin: 0; background: rgb(255, 220, 0); }</style>
<script>
let frameZooms = 0;
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    console.log('RESULT framezoom=' + ++frameZooms);
  }
}, { passive: false });
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url === '/frame' ? FRAME : PAGE),
);
const stack = await startStack({ token: 'pinch-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  hasTouch: true,
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms) => results.wait(key, ms);
const cdp = await context.newCDPSession(page);

await openHost(page, stack.app({ url: siteURL, log: '1' }));
check('page loaded', (await result('ready')) === '1');

const pixelAt = (x, y) => pagePixel(page, x, y);
// The gesture does not end exactly at 2 (steps multiply), so +-1 px
const clickAt190 = (text) => text && text.split(',').every((v) => Math.abs(Number(v) - 190) <= 1);
const RED = [255, 0, 0],
  GREEN = [0, 160, 0],
  WHITE = [255, 255, 255],
  MAGENTA = [255, 0, 255];
// A value of the page (JSON), through the console
let asked = 0;
async function pageValue(expression) {
  const key = 'value' + ++asked;
  await page.evaluate(
    ([key, expression]) =>
      window.blTest.eval(`console.log("RESULT ${key}=" + JSON.stringify(${expression}))`),
    [key, expression],
  );
  const value = await result(key, 10000);
  return value === null ? null : JSON.parse(value);
}
const viewport = () =>
  pageValue(
    '{ scale: visualViewport.scale, width: visualViewport.width, left: visualViewport.pageLeft, top: visualViewport.pageTop, layout: document.documentElement.clientWidth, wide: document.getElementById("wide").getBoundingClientRect().width }',
  );
const blockEngine = (ms) =>
  page.evaluate(
    (ms) =>
      window.blTest.eval(
        `(() => { const end = Date.now() + ${ms}; while (Date.now() < end); return 1; })()`,
      ),
    ms,
  );
const origin = await canvasOrigin(page);
const at = (x, y) => ({ x: origin.x + x, y: origin.y + y });
// Red and green twice as large, the center (100, 100) stays
const scaledTwice = async () =>
  near(await pixelAt(150, 150), RED) &&
  near(await pixelAt(250, 250), RED) &&
  near(await pixelAt(275, 125), RED) &&
  near(await pixelAt(450, 150), GREEN);
// Magenta (100..200, 400..500) twice as large at pageLeft 50, pageTop 350
const magentaTwice = async () =>
  near(await pixelAt(150, 150), MAGENTA) &&
  near(await pixelAt(280, 280), MAGENTA) &&
  near(await pixelAt(320, 150), WHITE);
const unscaled = async () =>
  near(await pixelAt(150, 150), RED) &&
  near(await pixelAt(275, 125), GREEN) &&
  near(await pixelAt(450, 150), WHITE);

await waitFor(unscaled, 20000);
const before = await viewport();
check(
  'before without pinch zoom',
  before?.scale === 1 && (await unscaled()),
  JSON.stringify(before),
);

// 1) Touchpad pinch (Ctrl + wheel) while the JS of the page blocks the engine thread: the
// compositor thread still shows the gesture right away
await blockEngine(5000);
await page.waitForTimeout(300);
const pinchStart = Date.now();
await cdp.send('Input.synthesizePinchGesture', {
  ...at(100, 100),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
const shownWhileBlocked = await waitFor(scaledTwice, 2500);
check(
  'touchpad pinch shows right away while the JS blocks',
  shownWhileBlocked && Date.now() - pinchStart < 4500,
  JSON.stringify({
    ms: Date.now() - pinchStart,
    red: await pixelAt(250, 250),
    green: await pixelAt(450, 150),
  }),
);
await screenshot(page, 'pinch-blocked');
// The passive wheel listener of the document did not block and reads along
check('the page reads the touchpad pinch passively', (await result('ctrlwheel', 15000)) !== null);

// 2) Afterwards the page knows the scale, the layout keeps its width
check('page gets visualViewport resize', (await result('vvresize', 15000)) !== null);
const after = await viewport();
check('visualViewport.scale is 2', Math.abs(after?.scale - 2) < 0.05, JSON.stringify(after));
check(
  'layout keeps its width',
  after?.layout === before.layout && Math.abs(after?.wide - before.wide) < 0.5,
  JSON.stringify({ before, after }),
);
check(
  'visualViewport half as wide, the center stays',
  Math.abs(after?.width - before.width / 2) < 2 &&
    Math.abs(after?.left - 50) < 2 &&
    Math.abs(after?.top - 50) < 2,
  JSON.stringify(after),
);
await page.waitForTimeout(500);
check(
  'repainted sharp after the takeover, same place',
  await waitFor(scaledTwice, 5000),
  JSON.stringify({ red: await pixelAt(250, 250), green: await pixelAt(450, 150) }),
);
// Clicks hit what is shown: (280, 280) is in the red box now
await page.mouse.click(at(280, 280).x, at(280, 280).y);
check(
  'click hits the enlarged box',
  clickAt190(await result('redclick', 10000)),
  results.get('redclick'),
);

// 3) Out again: not smaller than 1
await cdp.send('Input.synthesizePinchGesture', {
  ...at(300, 300),
  scaleFactor: 0.25,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await waitFor(async () => (await viewport())?.scale === 1, 10000);
const back = await viewport();
check(
  'out to scale 1',
  back?.scale === 1 && back.left === 0 && back.top === 0 && (await waitFor(unscaled, 5000)),
  JSON.stringify(back),
);

const zoomOutToTop = async () => {
  await cdp.send('Input.synthesizePinchGesture', {
    ...at(300, 300),
    scaleFactor: 0.25,
    relativeSpeed: 1600,
    gestureSourceType: 'mouse',
  });
  await waitFor(async () => (await viewport())?.scale === 1, 10000);
  await page.mouse.wheel(0, -3000);
  await waitFor(async () => (await viewport())?.top === 0 && (await unscaled()), 10000);
};
const zoomedAt = (top) => async () => {
  const value = await viewport();
  return (
    Math.abs(value?.scale - 2) < 0.05 &&
    Math.abs(value.left - 50) < 2 &&
    Math.abs(value.top - top) < 2
  );
};

// 3a) A click right after the gesture, before the core ends it by a timeout: the click ends
// it, the engine takes over the target before the click
results.delete('redclick');
await cdp.send('Input.synthesizePinchGesture', {
  ...at(100, 100),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await page.mouse.click(at(280, 280).x, at(280, 280).y);
check(
  'click right after the pinch hits the enlarged box',
  clickAt190(await result('redclick', 10000)),
  results.get('redclick'),
);
await zoomOutToTop();

// 3b) Scroll on right after the gesture: the wheel moves the scaled view, even before the
// engine thread took it over, nothing is lost
await page.mouse.move(at(500, 400).x, at(500, 400).y);
await cdp.send('Input.synthesizePinchGesture', {
  ...at(100, 100),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await page.mouse.wheel(0, 300);
await waitFor(zoomedAt(200), 10000);
await page.mouse.wheel(0, 300);
check(
  'wheel right after the pinch is not lost',
  (await waitFor(zoomedAt(350), 10000)) && (await waitFor(magentaTwice, 5000)),
  JSON.stringify(await viewport()),
);
await zoomOutToTop();

// 3c) The same while the JS blocks: zoom and scroll right away, the takeover afterwards keeps
// the scrolled place
await blockEngine(5000);
await page.waitForTimeout(300);
const pannedStart = Date.now();
await cdp.send('Input.synthesizePinchGesture', {
  ...at(100, 100),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await page.mouse.wheel(0, 300);
await page.waitForTimeout(100);
await page.mouse.wheel(0, 300);
const pannedWhileBlocked = await waitFor(magentaTwice, 2000);
check(
  'pinch and wheel while the JS blocks',
  pannedWhileBlocked && Date.now() - pannedStart < 4500,
  JSON.stringify({
    ms: Date.now() - pannedStart,
    inside: await pixelAt(280, 280),
    outside: await pixelAt(320, 150),
  }),
);
check(
  'afterwards: scale 2, the wheel is taken over too',
  (await waitFor(zoomedAt(350), 15000)) && (await waitFor(magentaTwice, 5000)),
  JSON.stringify(await viewport()),
);
await zoomOutToTop();

// 3d) First scroll in the scroll thread, then zoom, both while the JS blocks: the compositor
// takes the shown scroll position
await blockEngine(6000);
await page.waitForTimeout(300);
await page.mouse.move(at(500, 400).x, at(500, 400).y);
await page.mouse.wheel(0, 300);
const scrolledWhileBlocked = await waitFor(
  async () => near(await pixelAt(150, 150), MAGENTA),
  2000,
);
await cdp.send('Input.synthesizePinchGesture', {
  ...at(100, 100),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
check(
  'scroll and pinch while the JS blocks',
  scrolledWhileBlocked && (await waitFor(magentaTwice, 2000)),
  JSON.stringify({ inside: await pixelAt(280, 280), outside: await pixelAt(320, 150) }),
);
await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 15000);
const scrolledZoom = await viewport();
check(
  'afterwards: scale 2 at the scrolled place',
  Math.abs(scrolledZoom?.scale - 2) < 0.05 &&
    Math.abs(scrolledZoom.left - 50) < 2 &&
    Math.abs(scrolledZoom.top - 350) < 2 &&
    (await waitFor(magentaTwice, 5000)),
  JSON.stringify(scrolledZoom),
);
await zoomOutToTop();

// 4) Ctrl + mouse wheel stays page zoom (step 110 %), without pinch
const ctrlWheelAt = (point, target = page) =>
  target.evaluate(({ x, y }) => {
    const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
      (c) => c.style.display !== 'none',
    );
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, point);
const zoomText = (target = page) =>
  target.evaluate(() => `${Math.round(window.blTest.view().zoom * 100)} %`);
await ctrlWheelAt(at(300, 300));
const zoomLabel = await zoomText();
check(
  'Ctrl + mouse wheel: page zoom',
  zoomLabel === '110 %' && (await viewport())?.scale === 1,
  zoomLabel,
);
await page.evaluate(() => window.blTest.view().setZoom(1));
await waitFor(async () => (await viewport())?.layout === before.layout, 10000);

// 4b) Ctrl + wheel goes to the page first: the "map" calls preventDefault, then neither the
// view (touchpad) nor the page (mouse wheel) zooms
await cdp.send('Input.synthesizePinchGesture', {
  ...at(325, 600),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await result('mapzoom', 10000);
await page.waitForTimeout(1000);
// Every event of the gesture goes to the page as cancelable
check(
  'touchpad pinch on the map: the page zooms itself, the view does not',
  Number(results.get('mapzoom')) > 1 && (await viewport())?.scale === 1 && (await unscaled()),
  JSON.stringify({ mapzoom: results.get('mapzoom'), viewport: await viewport() }),
);
const zoomsBefore = Number(results.get('mapzoom'));
await ctrlWheelAt(at(325, 600));
await waitFor(() => Number(results.get('mapzoom')) > zoomsBefore, 10000);
await page.waitForTimeout(500);
check(
  'Ctrl + mouse wheel on the map: no page zoom',
  Number(results.get('mapzoom')) === zoomsBefore + 1 && (await zoomText()) === '100 %',
  await zoomText(),
);

// 4b') The same with the map in the iframe: the preventDefault of its document counts
await cdp.send('Input.synthesizePinchGesture', {
  ...at(125, 600),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await result('framezoom', 10000);
await page.waitForTimeout(1000);
check(
  'touchpad pinch on the map in the iframe: only it zooms',
  Number(results.get('framezoom')) > 1 && (await viewport())?.scale === 1 && (await unscaled()),
  JSON.stringify({ framezoom: results.get('framezoom'), viewport: await viewport() }),
);
const frameZoomsBefore = Number(results.get('framezoom'));
await ctrlWheelAt(at(125, 600));
await waitFor(() => Number(results.get('framezoom')) > frameZoomsBefore, 10000);
await page.waitForTimeout(500);
check(
  'Ctrl + mouse wheel on the map in the iframe: no page zoom',
  Number(results.get('framezoom')) === frameZoomsBefore + 1 && (await zoomText()) === '100 %',
  JSON.stringify({ framezoom: results.get('framezoom'), zoom: await zoomText() }),
);

// 4c) A wheel listener without preventDefault: the first event is cancelable, after the answer
// the view zooms, the page reads the rest along
await cdp.send('Input.synthesizePinchGesture', {
  ...at(700, 150),
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
const grabZoomed = await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 10000);
check(
  'listener without preventDefault: touchpad pinch zooms the view',
  grabZoomed && results.get('grabcancelable') === 'true' && results.get('grabpassive') === '1',
  JSON.stringify({
    cancelable: results.get('grabcancelable'),
    passive: results.get('grabpassive'),
    viewport: await viewport(),
  }),
);
await zoomOutToTop();

// 5) Two fingers: nothing zooms on a box with touch-action: none
const touchPinch = async (cx, cy, from, to) => {
  const points = (d) => [
    { ...at(cx - d / 2, cy), id: 1 },
    { ...at(cx + d / 2, cy), id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  // Wait for the answer of the page to touchstart (preventDefault, touch-action)
  await page.waitForTimeout(300);
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: points(from + ((to - from) * i) / 10),
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
results.delete('vvresize');
await touchPinch(700, 450, 100, 200);
await page.waitForTimeout(1500);
check(
  'touch-action: none prevents pinch zoom',
  (await viewport())?.scale === 1 && (await unscaled()),
);

// 5b) When the page wants the two fingers itself (preventDefault on touchmove), the started
// gesture ends and the view goes back
await touchPinch(700, 150, 100, 200);
await page.waitForTimeout(1500);
check(
  'preventDefault of the page cancels pinch zoom',
  (await result('grabbed', 5000)) === '1' && (await viewport())?.scale === 1 && (await unscaled()),
  JSON.stringify(await viewport()),
);

// 6) Two fingers apart around (100, 100): twice as large
await touchPinch(100, 100, 100, 200);
check('two fingers: page gets visualViewport resize', (await result('vvresize', 15000)) !== null);
const touched = await viewport();
check(
  'two fingers: visualViewport.scale is 2, layout the same',
  Math.abs(touched?.scale - 2) < 0.05 &&
    touched.layout === before.layout &&
    Math.abs(touched.wide - before.wide) < 0.5,
  JSON.stringify(touched),
);
check(
  'two fingers: content twice as large',
  await waitFor(scaledTwice, 5000),
  JSON.stringify({ red: await pixelAt(250, 250), green: await pixelAt(450, 150) }),
);

// A new page starts without pinch zoom, back brings it back
results.delete('ready');
await load(page, `${siteURL}?new`);
await result('ready', 20000);
const fresh = await viewport();
results.delete('ready');
await page.evaluate(() => window.blTest.view().back());
await result('ready', 20000);
await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 10000);
const restored = await viewport();
check(
  'new page without pinch zoom, back restores it',
  fresh?.scale === 1 && Math.abs(restored?.scale - 2) < 0.05,
  JSON.stringify({ fresh, restored }),
);

await screenshot(page, 'pinch');
await page.close();

// 7) Without the compositor (compositing: false) the engine thread scales itself
const plain = await context.newPage();
const plainResults = collect(plain);
await openHost(plain, stack.app({ url: siteURL, compositing: '0' }));
check('loaded without the compositor', (await plainResults.wait('ready')) === '1');
const plainPixel = (x, y) => pagePixel(plain, x, y);
await waitFor(async () => near(await plainPixel(150, 150), RED), 20000);
const plainCDP = await context.newCDPSession(plain);
const plainOrigin = await canvasOrigin(plain);
// Here too Ctrl + wheel goes to the page first: the map zooms itself
const plainResizes = plainResults.get('vvresize');
await plainCDP.send('Input.synthesizePinchGesture', {
  x: plainOrigin.x + 325,
  y: plainOrigin.y + 600,
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
const plainMap = await plainResults.wait('mapzoom', 10000);
await plain.waitForTimeout(1000);
check(
  'without the compositor: the map zooms itself, the view does not',
  plainMap !== null &&
    plainResults.get('vvresize') === plainResizes &&
    near(await plainPixel(250, 250), WHITE) &&
    near(await plainPixel(150, 150), RED),
  JSON.stringify({
    mapzoom: plainMap,
    resizes: [plainResizes, plainResults.get('vvresize')],
    red: await plainPixel(150, 150),
    white: await plainPixel(250, 250),
  }),
);
await plainCDP.send('Input.synthesizePinchGesture', {
  x: plainOrigin.x + 125,
  y: plainOrigin.y + 600,
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
await plainResults.wait('framezoom', 10000);
await plain.waitForTimeout(1000);
const plainFrameZooms = Number(plainResults.get('framezoom'));
await ctrlWheelAt({ x: plainOrigin.x + 125, y: plainOrigin.y + 600 }, plain);
await waitFor(() => Number(plainResults.get('framezoom')) > plainFrameZooms, 10000);
await plain.waitForTimeout(500);
check(
  'without the compositor: the map in the iframe zooms itself, neither the view nor the page',
  plainFrameZooms > 1 &&
    Number(plainResults.get('framezoom')) === plainFrameZooms + 1 &&
    plainResults.get('vvresize') === plainResizes &&
    near(await plainPixel(250, 250), WHITE) &&
    (await zoomText(plain)) === '100 %',
  JSON.stringify({
    framezoom: plainResults.get('framezoom'),
    resizes: [plainResizes, plainResults.get('vvresize')],
    zoom: await zoomText(plain),
  }),
);
plainResults.delete('vvresize');
await plainCDP.send('Input.synthesizePinchGesture', {
  x: plainOrigin.x + 100,
  y: plainOrigin.y + 100,
  scaleFactor: 2,
  relativeSpeed: 1600,
  gestureSourceType: 'mouse',
});
const plainScaled = await waitFor(
  async () => near(await plainPixel(250, 250), RED) && near(await plainPixel(450, 150), GREEN),
  10000,
);
check(
  'without the compositor: pinch zoom',
  plainScaled && (await plainResults.wait('vvresize', 10000)) !== null,
  JSON.stringify({ red: await plainPixel(250, 250), green: await plainPixel(450, 150) }),
);
await browser.close();
finish();
