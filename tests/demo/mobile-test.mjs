// The phone layout of the demo UI (apps/demo) on an emulated phone, portrait and landscape: the
// compact toolbar sits at the bottom, fits and has touch targets of at least 44 px, the address
// entry navigates with its suggestions above the toolbar (also above a keyboard that makes the
// page smaller), the tab overview shows the tabs, switches and closes one, the menu opens as a
// bottom sheet on the toolbar, the find
// bar, the permission prompt and the sign-in dialog are fully visible, and the desktop layout
// comes back above the breakpoint. An Android phone as host gets the iPhone device by default.
// Screenshots: build/e2e-mobile-*.png.
//
//   node tests/demo/mobile-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  check,
  collect,
  emulateTouchPoints,
  finish,
  launch,
  permissions,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const page = (title) =>
  `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><h1>${title}</h1><script>console.log('RESULT loaded=' + document.title)</script>`;
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/auth' && req.headers.authorization !== `Basic ${btoa('user:secret')}`) {
    res
      .writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="phone"' })
      .end('denied');
    return;
  }
  const name = req.url.slice(1) || 'one';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(`Page ${name}`));
});

const stack = await startStack({ app: 'demo', token: 'mobile-token-0123456789abcdef' });
const browser = await launch();
// Chrome on an Android phone
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const context = await browser.newContext({
  viewport: PORTRAIT,
  userAgent: ANDROID_UA,
  deviceScaleFactor: 3,
  hasTouch: true,
  // Playwright has no isMobile in Firefox
  ...(BROWSER === 'chromium' ? { isMobile: true } : {}),
  // Sheets are measured where they end up, without their short slide-in
  reducedMotion: 'reduce',
  geolocation: { latitude: 46.948, longitude: 7.447 },
  permissions: permissions(['geolocation']),
});
await emulateTouchPoints(context);
const tab = await context.newPage();
const results = collect(tab, /RESULT (\w+)=(.*?)(\s+\(|$)/);
async function loaded(title, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.get('loaded') === title) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
const shown = (selector, ms = 10000) =>
  tab
    .locator(selector)
    .first()
    .waitFor({ state: 'visible', timeout: ms })
    .then(
      () => true,
      () => false,
    );
/** Rectangles of the visible elements of selector, with the window size. */
const boxes = (selector) =>
  tab.evaluate((selector) => {
    const list = [...document.querySelectorAll(selector)]
      .filter((node) => node.getClientRects().length)
      .map((node) => node.getBoundingClientRect().toJSON());
    return { list, width: innerWidth, height: innerHeight };
  }, selector);
/** True when every visible element of selector is inside the window (and there is one). */
async function inside(selector) {
  const { list, width, height } = await boxes(selector);
  const ok =
    list.length > 0 &&
    list.every(
      (box) =>
        box.left >= -0.5 &&
        box.top >= -0.5 &&
        box.right <= width + 0.5 &&
        box.bottom <= height + 0.5,
    );
  return [ok, JSON.stringify(list.map((box) => [box.left, box.top, box.width, box.height]))];
}
/** True when every visible element of selector is at least min px wide and high. */
async function touchSize(selector, min = 44) {
  const { list } = await boxes(selector);
  const ok =
    list.length > 0 && list.every((box) => box.width >= min - 0.5 && box.height >= min - 0.5);
  return [ok, JSON.stringify(list.map((box) => [Math.round(box.width), Math.round(box.height)]))];
}
const TOOLBAR = '#toolbar > button, #address';
const TOOLBAR_BUTTONS = '#toolbar > button';

await tab.goto(stack.app({ url: `${siteURL}one` }));
check('first page', await loaded('Page one', TIMEOUT));
const device = await tab.evaluate(() => window.blTest.settings().device);
await tab.evaluate(() =>
  window.blTest.eval(
    "console.log('RESULT identity=' + /iPhone.*Mobile/.test(navigator.userAgent) + ',' + !/Chrome/.test(navigator.userAgent) + ',' + screen.width + ',' + navigator.maxTouchPoints)",
  ),
);
check(
  'Android host: the iPhone by default (#332), with the screen of the host',
  device === 'iphone' &&
    (await results.wait('identity', 10000)) ===
      `true,true,${await tab.evaluate(() => screen.width)},5`,
  `${device} ${results.get('identity')}`,
);
check(
  'Android host: the page area keeps the whole window (no device frame)',
  await tab.evaluate(() => {
    const viewport = document.getElementById('viewport');
    return !viewport.classList.contains('device') && viewport.offsetWidth === innerWidth;
  }),
);

// Portrait: back, address, tab count and menu; the rest moved into the menu
const visible = await tab.evaluate(() =>
  ['tabs', 'back', 'forward', 'reload', 'bookmark', 'tab-count', 'menu-button']
    .filter((id) => document.getElementById(id).getClientRects().length)
    .join(','),
);
check('portrait: compact toolbar', visible === 'back,tab-count,menu-button', visible);
check('portrait: toolbar inside the window', ...(await inside(TOOLBAR)));
check('portrait: toolbar buttons of 44 px', ...(await touchSize(TOOLBAR_BUTTONS)));
const addressWidth = (await boxes('#address')).list[0]?.width ?? 0;
check(
  'portrait: the address takes the room',
  addressWidth > 390 - 4 * 44 - 30,
  String(addressWidth),
);
check(
  'portrait: nothing wider than the window',
  await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
);
check(
  'portrait: 16 px text in the address (no zoom on focus in iOS)',
  (await tab.$eval('#address', (node) => getComputedStyle(node).fontSize)) === '16px',
);
check(
  'portrait: the address bar shows only the host',
  (await tab.inputValue('#address')) === new URL(siteURL).host,
  await tab.inputValue('#address'),
);
const bar = async () => (await boxes('#chrome')).list[0];
const portraitBar = await bar();
const area = (await boxes('#viewport')).list[0];
check(
  'portrait: the toolbar at the bottom, the page above it from the top',
  !!portraitBar &&
    Math.abs(portraitBar.bottom - PORTRAIT.height) < 1 &&
    Math.abs(area.top) < 1 &&
    Math.abs(area.bottom - portraitBar.top) < 1,
  JSON.stringify([portraitBar, area]),
);
await screenshot(tab, 'mobile-portrait');

// Address entry: the tap shows the whole address, selected
await tab.tap('#address');
const tapped = await tab.evaluate(() => {
  const field = document.getElementById('address');
  return [field.value, field.selectionStart, field.selectionEnd];
});
check(
  'address tap: the whole address, selected',
  tapped[0] === `${siteURL}one` && tapped[1] === 0 && tapped[2] === tapped[0].length,
  JSON.stringify(tapped),
);
await tab.fill('#address', `${siteURL}two`);
const above = async () => {
  const [list, toolbar] = [(await boxes('#suggestions')).list[0], await bar()];
  return [
    !!list && !!toolbar && Math.abs(list.bottom - toolbar.top) < 1 && list.top >= 0,
    JSON.stringify([list, toolbar]),
  ];
};
check('address entry: the suggestions open upwards above the toolbar', ...(await above()));
// An on-screen keyboard that makes the page smaller (Chrome on Android): the toolbar and the
// suggestions stay above it
await tab.setViewportSize({ width: PORTRAIT.width, height: 520 });
await tab.waitForTimeout(300);
const raised = await bar();
check(
  'address entry: the toolbar above the keyboard',
  !!raised && Math.abs(raised.bottom - 520) < 1,
  JSON.stringify(raised),
);
check('address entry: the suggestions above the toolbar with the keyboard', ...(await above()));
const typed = await tab.inputValue('#address');
// The keyboard goes away without a blur (the back button of Android): editing ends
await tab.setViewportSize(PORTRAIT);
await tab.waitForTimeout(300);
check(
  'keyboard closed: editing ends, no suggestions left over',
  await tab.evaluate(
    () => document.activeElement?.id !== 'address' && document.getElementById('suggestions').hidden,
  ),
);
await tab.tap('#address');
await tab.fill('#address', typed);
await tab.press('#address', 'Enter');
check('address entry navigates', await loaded('Page two'));

// Tab overview: a new tab from there, switch, close
await tab.tap('#tab-count');
check('tab overview opens', await shown('#tab-overview'));
check('tab overview: one card', (await tab.locator('.overview-card').count()) === 1);
await tab.tap('#tab-overview .overview-new');
check(
  'new tab from the overview: the new tab page, no keyboard',
  await tab.evaluate(
    () =>
      document.getElementById('tab-overview').hidden &&
      !document.getElementById('new-tab-page').hidden &&
      document.activeElement !== document.getElementById('address'),
  ),
);
await tab.fill('#address', `${siteURL}three`);
await tab.press('#address', 'Enter');
check('second tab loads', await loaded('Page three'));
check('tab count 2', (await tab.textContent('#tab-count')).trim() === '2');
await tab.tap('#tab-count');
await shown('#tab-overview');
const titles = await tab.locator('.overview-card .overview-title').allTextContents();
check(
  'tab overview shows the tabs',
  JSON.stringify(titles) === JSON.stringify(['Page two', 'Page three']),
  JSON.stringify(titles),
);
check(
  'tab overview: the active tab marked',
  (await tab.textContent('.overview-card.active .overview-title')) === 'Page three',
);
check(
  'tab overview inside the window',
  ...(await inside('.overview-card, #tab-overview header button')),
);
check('tab overview: close buttons of 44 px', ...(await touchSize('.overview-close')));
await screenshot(tab, 'mobile-tabs');
await tab.locator('.overview-card', { hasText: 'Page two' }).locator('.overview-open').tap();
const switched = await tab
  .waitForFunction(() => window.blTest.view()?.url.endsWith('/two'), null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check(
  'tab overview: a tap switches and closes it',
  switched && (await tab.evaluate(() => document.getElementById('tab-overview').hidden)),
);
await tab.tap('#tab-count');
await tab.locator('.overview-card', { hasText: 'Page three' }).locator('.overview-close').tap();
const closed = await tab
  .waitForFunction(() => document.querySelectorAll('.overview-card').length === 1, null, {
    timeout: 10000,
  })
  .then(
    () => true,
    () => false,
  );
check(
  'tab overview: the cross closes a tab',
  closed && (await tab.textContent('#tab-count')).trim() === '1',
);
await tab.tap('#tab-overview .overview-done');

// Menu as a bottom sheet with the hidden toolbar buttons
await tab.tap('#menu-button');
check('menu opens', await shown('#side-panel'));
const sheet = (await boxes('#side-panel')).list[0];
const sheetBar = await bar();
check(
  'menu: a sheet on the toolbar over the whole width',
  !!sheet &&
    Math.abs(sheet.bottom - sheetBar.top) < 1 &&
    sheet.width === PORTRAIT.width &&
    sheet.top > 0,
  JSON.stringify([sheet, sheetBar]),
);
check('menu inside the window', ...(await inside('#side-panel button')));
check(
  'menu: items of 44 px',
  ...(await touchSize('#side-panel .panel-menu-item, #side-panel .panel-icon')),
);
const quick = await tab.locator('#side-panel .panel-icon').allTextContents();
check(
  'menu: forward, reload and bookmark with icon and label',
  JSON.stringify(quick) === JSON.stringify(['Forward', 'Reload', 'Bookmark']) &&
    (await tab.locator('#side-panel .panel-icon svg').count()) === 3,
  JSON.stringify(quick),
);
await screenshot(tab, 'mobile-menu');
await tab.touchscreen.tap(PORTRAIT.width / 2, 20);
check(
  'menu: a tap outside closes it',
  await tab.evaluate(() => document.getElementById('side-panel').hidden),
);

// Find bar over the whole width
await tab.tap('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Find in page' }).tap();
check('find bar opens', await shown('#find-bar'));
check('find bar inside the window', ...(await inside('#find-bar, #find-bar button')));
await tab.tap('#find-close');

// Permission prompt of a page
results.delete('geo');
await tab.evaluate(() =>
  window.blTest.eval(
    "navigator.geolocation.getCurrentPosition((p) => console.log('RESULT geo=' + p.coords.latitude.toFixed(2)), (e) => console.log('RESULT geo=error' + e.code))",
  ),
);
check('permission prompt appears', await shown('.bl-permission-prompt'));
check(
  'permission prompt fully visible',
  ...(await inside('.bl-permission-prompt, .bl-permission-prompt button')),
);
check('permission prompt: buttons of 44 px', ...(await touchSize('.bl-permission-prompt button')));
await screenshot(tab, 'mobile-prompt');
await tab.locator('.bl-permission-prompt button', { hasText: 'Allow' }).tap();
check(
  'permission prompt: Allow',
  (await results.wait('geo', 15000)) === '46.95',
  results.get('geo'),
);

// Sign-in dialog of HTTP authentication
await tab.fill('#address', `${siteURL}auth`);
await tab.press('#address', 'Enter');
check('sign-in dialog appears', await shown('.bl-login-prompt'));
check(
  'sign-in dialog fully visible',
  ...(await inside('.bl-login-prompt, .bl-login-prompt input, .bl-login-prompt button')),
);
await screenshot(tab, 'mobile-login');
await tab.fill('.bl-login-prompt input[name=username]', 'user');
await tab.fill('.bl-login-prompt input[name=password]', 'secret');
await tab.locator('.bl-login-prompt .bl-sign-in').tap();
check('sign-in dialog: signed in', await loaded('Page auth'));

// Landscape: still the compact toolbar, sheets fit the low window
await tab.setViewportSize(LANDSCAPE);
check(
  'landscape: compact toolbar',
  await tab.evaluate(() => !document.getElementById('tabs').getClientRects().length),
);
check('landscape: toolbar inside the window', ...(await inside(TOOLBAR)));
// The view paints in the new size after a moment
await tab.waitForTimeout(1500);
await screenshot(tab, 'mobile-landscape');
await tab.tap('#menu-button');
await shown('#side-panel');
const low = (await boxes('#side-panel')).list[0];
const lowBar = await bar();
check(
  'landscape: the menu sheet fits the height on the toolbar at the bottom',
  !!low &&
    low.top >= 0 &&
    Math.abs(low.bottom - lowBar.top) < 1 &&
    Math.abs(lowBar.bottom - LANDSCAPE.height) < 1,
  JSON.stringify([low, lowBar]),
);
await screenshot(tab, 'mobile-landscape-menu');
await tab.touchscreen.tap(20, 20);
await tab.tap('#tab-count');
check(
  'landscape: tab overview inside the window',
  ...(await inside('.overview-card, #tab-overview header button')),
);
await tab.tap('#tab-overview .overview-done');

// Above the breakpoint the desktop layout comes back
await tab.setViewportSize({ width: 1100, height: 700 });
const desktop = await tab.evaluate(() =>
  ['tabs', 'forward', 'reload', 'bookmark', 'tab-count']
    .map((id) => `${id}=${document.getElementById(id).getClientRects().length > 0}`)
    .join(','),
);
check(
  'desktop layout above the breakpoint',
  desktop === 'tabs=true,forward=true,reload=true,bookmark=true,tab-count=false',
  desktop,
);
await context.close();

// An iPad as host: the iPad device by default, the page area over the whole wide window
const tablet = await browser.newContext({
  viewport: { width: 1024, height: 1366 },
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
await emulateTouchPoints(tablet);
const ipad = await tablet.newPage();
const ipadResults = collect(ipad, /RESULT (\w+)=(.*?)(\s+\(|$)/);
await ipad.goto(stack.app({ url: `${siteURL}tablet` }));
await ipadResults.wait('loaded', TIMEOUT);
const ipadArea = await ipad.evaluate(() => {
  const viewport = document.getElementById('viewport');
  return `${window.blTest.settings().device},${viewport.classList.contains('device')},${viewport.offsetWidth}`;
});
check('iPad host: the page area keeps the whole window', ipadArea === 'ipad,false,1024', ipadArea);
await screenshot(ipad, 'mobile-ipad');

await browser.close();
finish();
