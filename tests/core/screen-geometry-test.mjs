// Window and screen geometry like a browser's: the host window is the window of the pages
// (window.screenX/Y, screenLeft/Top, outerWidth/Height), so the UI around the view counts as its
// chrome, and input events carry screen coordinates: the host's viewport on the screen plus the
// view's place in the host page (plus the frame's place in the page). Before #634 the engine
// reported the view as the window at 0, 0 and every screenX/Y equal to clientX/Y, which DataDome's
// slider takes for a synthetic event (pageX == screenX && pageY == screenY). Mouse, pointer and
// touch events in the page and in a cross-site frame; screen.availLeft/availTop like the host's;
// with an emulated phone everything stays inside its screen.
//
//   node tests/core/screen-geometry-test.mjs [engine-dir]
import {
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  emulateTouchPoints,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Where the frame lies in the page
const FRAME = { x: 200, y: 150 };
// The UI of the host page around the view (the demo's tab strip and toolbar)
const CHROME = { left: 40, top: 70 };

// Each document reports screenX less clientX and screenY less clientY of its events
const listeners = (name) => `
for (const type of ['mousedown', 'pointerdown', 'touchstart']) {
  addEventListener(type, (e) => {
    const point = e.changedTouches ? e.changedTouches[0] : e;
    const kind = e.pointerType === 'touch' ? '_touch' : '';
    console.log('RESULT ${name}_' + type + kind + '=' + (point.screenX - point.clientX) + ',' + (point.screenY - point.clientY));
  });
}`;
const MAIN = (frame) => `<!doctype html><title>geometry</title><body style="margin:0;height:2000px">
<iframe src="${frame}" style="position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:300px;height:200px;border:0"></iframe>
<script>${listeners('main')}
window.report = (key) => console.log('RESULT ' + key + '=' + JSON.stringify({
  screenX, screenY, screenLeft, screenTop, outerWidth, outerHeight, innerWidth, innerHeight,
  availLeft: screen.availLeft, availTop: screen.availTop, width: screen.width, height: screen.height,
}));
console.log('RESULT main=loaded');
</script>`;
const FRAME_PAGE = `<!doctype html><body style="margin:0;background:#ddd"><script>${listeners('frame')}
console.log('RESULT frame=loaded');
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = url.pathname === '/frame' ? FRAME_PAGE : MAIN(url.searchParams.get('frame'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
});
const port = new URL(siteURL).port;
// localhost is another site than 127.0.0.1
const mainURL = `http://127.0.0.1:${port}/main?frame=${encodeURIComponent(`http://localhost:${port}/frame`)}`;

const stack = await startStack({ token: 'screen-geometry-token-0123456789' });
// With a display a real window of the host, away from the corner of the screen (headless Chromium
// has its window at 0, 0 without chrome)
const browser = await launch({
  args: ['--window-position=120,60'],
  headless: !process.env.DISPLAY,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
});
await emulateTouchPoints(context);
const page = await context.newPage();
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: mainURL })));
// The UI around the view, like the demo's
await page.evaluate(({ left, top }) => {
  document.getElementById('view').style.inset = `${top}px 0 0 ${left}px`;
}, CHROME);
check(
  'page and frame loaded',
  (await results.wait('main')) === 'loaded' && (await results.wait('frame')) === 'loaded',
);
await page.waitForTimeout(1000);
// The host's own view of its viewport on the screen, from its own events
await page.evaluate(() => {
  for (const type of ['pointerdown', 'touchstart'])
    addEventListener(
      type,
      (e) => {
        const point = e.changedTouches ? e.changedTouches[0] : e;
        window.hostOffset = [point.screenX - point.clientX, point.screenY - point.clientY];
      },
      { capture: true },
    );
});

const host = await page.evaluate(() => ({
  screenX,
  screenY,
  outerWidth,
  outerHeight,
  innerWidth,
  innerHeight,
  availLeft: screen.availLeft,
  availTop: screen.availTop,
}));
const canvas = await canvasOrigin(page);
const report = async (key) => {
  results.delete(key);
  await evalPage(page, `report('${key}')`);
  return JSON.parse(await results.wait(key, 10000));
};
const offset = async (key) => {
  const value = await results.wait(key, 10000);
  results.delete(key);
  return value?.split(',').map(Number) ?? null;
};
const near = (a, b) => !!a && !!b && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;

// A click in the page: the host's offset of that event plus the canvas and, in the frame, the frame
const click = async (x, y) => {
  await page.mouse.click(canvas.x + x, canvas.y + y);
  return page.evaluate(() => window.hostOffset);
};
const hostOffset = await click(20, 20);
const view = [hostOffset[0] + canvas.x, hostOffset[1] + canvas.y];
const inFrame = [view[0] + FRAME.x, view[1] + FRAME.y];
console.log(`   host ${JSON.stringify(host)}, its viewport at ${hostOffset}, view at ${view}`);
for (const type of ['mousedown', 'pointerdown']) {
  const seen = await offset(`main_${type}`);
  check(
    `${type} in the page: screen - client = the view's place on the screen`,
    near(seen, view),
    `${seen} against ${view}`,
  );
}
await click(FRAME.x + 30, FRAME.y + 30);
for (const type of ['mousedown', 'pointerdown']) {
  const seen = await offset(`frame_${type}`);
  check(
    `${type} in the cross-site frame: plus the frame's place`,
    near(seen, inFrame),
    `${seen} against ${inFrame}`,
  );
}

const geometry = await report('desktop');
check(
  'screenX/Y and screenLeft/Top are the host window',
  geometry.screenX === host.screenX &&
    geometry.screenY === host.screenY &&
    geometry.screenLeft === host.screenX &&
    geometry.screenTop === host.screenY,
  JSON.stringify(geometry),
);
const viewWidth = 1280 - CHROME.left;
const viewHeight = 800 - CHROME.top;
check(
  'outer - inner: the host chrome plus the UI around the view',
  geometry.innerWidth === viewWidth &&
    geometry.innerHeight === viewHeight &&
    geometry.outerWidth - geometry.innerWidth === host.outerWidth - host.innerWidth + CHROME.left &&
    geometry.outerHeight - geometry.innerHeight ===
      host.outerHeight - host.innerHeight + CHROME.top &&
    geometry.outerWidth - geometry.innerWidth > 0 &&
    geometry.outerHeight - geometry.innerHeight > 0,
  `${geometry.outerWidth - geometry.innerWidth} x ${geometry.outerHeight - geometry.innerHeight}`,
);
check(
  'screen.availLeft/availTop like the host',
  geometry.availLeft === (host.availLeft ?? 0) && geometry.availTop === (host.availTop ?? 0),
  `${geometry.availLeft},${geometry.availTop}`,
);

if (chromiumOnly('touch events (CDP touch)')) {
  await page.touchscreen.tap(canvas.x + 60, canvas.y + 60);
  const touchOffset = await page.evaluate(() => window.hostOffset);
  const touchView = [touchOffset[0] + canvas.x, touchOffset[1] + canvas.y];
  for (const type of ['touchstart', 'pointerdown_touch', 'mousedown']) {
    const seen = await offset(`main_${type}`);
    check(`tap: ${type} in the page`, near(seen, touchView), `${seen} against ${touchView}`);
  }
  await page.touchscreen.tap(canvas.x + FRAME.x + 60, canvas.y + FRAME.y + 60);
  const touchFrame = [touchView[0] + FRAME.x, touchView[1] + FRAME.y];
  for (const type of ['touchstart', 'pointerdown_touch']) {
    const seen = await offset(`frame_${type}`);
    check(
      `tap: ${type} in the cross-site frame`,
      near(seen, touchFrame),
      `${seen} against ${touchFrame}`,
    );
  }
}

// An emulated phone: its browser window fills its screen, the bar above the view
await page.evaluate(() =>
  window.blTest.browser.setDevice({
    width: 390,
    height: 844,
    pixelRatio: 2,
    touch: true,
    mobile: true,
  }),
);
await page.waitForTimeout(1500);
const phone = await report('phone');
check(
  'phone: window at 0, 0 with the size of the screen',
  phone.screenX === 0 &&
    phone.screenY === 0 &&
    phone.outerWidth === 390 &&
    phone.outerHeight === 844 &&
    phone.width === 390 &&
    phone.height === 844 &&
    phone.availLeft === 0 &&
    phone.availTop === 0,
  JSON.stringify(phone),
);
const phoneCanvas = await canvasOrigin(page);
await page.touchscreen.tap(phoneCanvas.x + 50, phoneCanvas.y + 50);
const bar = [0, 844 - phone.innerHeight];
for (const type of ['touchstart', 'mousedown']) {
  const seen = await offset(`main_${type}`);
  check(
    `phone: ${type} below the browser bar, inside the screen`,
    near(seen, bar),
    `${seen} against ${bar}`,
  );
}

await browser.close();
finish();
