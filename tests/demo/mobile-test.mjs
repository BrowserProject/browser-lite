// The phone layout of the demo UI (apps/demo) on an emulated phone, portrait and landscape: the
// compact toolbar sits at the bottom, fits and has touch targets of at least 44 px, the address
// entry navigates with its suggestions above the toolbar (also above a keyboard that makes the
// window smaller, while the page keeps its size like in Chrome; a field in the page area makes it
// smaller), the tab overview shows the tabs, switches and closes one, a long press on a link shows
// its address and only its commands, Open link in new tab opens it in the background with a
// message to switch to it, the menu opens as a bottom sheet on the toolbar, an empty bookmarks
// sheet names its Bookmark button, the find bar takes the toolbar's place without resizing the
// page, a match near the bottom of the page is above it and Ctrl+L closes it, the permission
// prompt and the sign-in dialog are fully visible, the section names of the settings stay on one
// line at 390 and 360 px, the close button of the settings stays at the top while they scroll, the
// bar slides away while the user scrolls a page down and comes back when they scroll up (the page
// gets its room) and comes back with the progress at once when the page navigates (also while it
// still loads), and the desktop layout comes back above the breakpoint. An Android phone as host
// gets the iPhone device by default.
// Screenshots: build/e2e-mobile-*.png.
//
//   node tests/demo/mobile-test.mjs [engine-dir]
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
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
const { url: siteURL } = await serve(async (req, res) => {
  if (req.url === '/auth' && req.headers.authorization !== `Basic ${btoa('user:secret')}`) {
    res
      .writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="phone"' })
      .end('denied');
    return;
  }
  const name = req.url.slice(1) || 'one';
  // A word just above the bottom of the view, where the find bar lies when it covers the page
  if (name === 'find') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        `${page('Page find')}<style>body{margin:0}h1{display:none}</style><div style="height:calc(100vh - 44px)"></div><p style="margin:0;font:16px/20px sans-serif">zebra</p><div style="height:2000px"></div>`,
      );
    return;
  }
  // An image that holds the load of its page, a page that answers late
  if (name === 'hang') {
    setTimeout(() => res.writeHead(404).end(), 20000);
    return;
  }
  if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000));
  const long = ['long', 'long-loading', 'slow'].includes(name);
  const body =
    (long ? '<div style="height:5000px"></div>' : '') +
    (name === 'long-loading' ? '<img src="/hang">' : '');
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(page(`Page ${name}`) + body);
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
// Chrome on Android shows no PDF in a frame
await context.addInitScript(() =>
  Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false }),
);
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

/** The height of the page as the engine lays it out (its innerHeight). */
async function pageHeight() {
  results.delete('height');
  await tab.evaluate(() => window.blTest.eval('console.log("RESULT height=" + innerHeight)'));
  return Number(await results.wait('height', 10000));
}
const fullHeight = await pageHeight();

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
// Like Chrome the keyboard of the address bar covers the page instead of making it smaller, so
// the page is not laid out again
await tab.waitForTimeout(700);
const coveredHeight = await pageHeight();
check(
  'address entry: the page keeps its size under the keyboard',
  fullHeight > 520 && coveredHeight === fullHeight,
  `${fullHeight} -> ${coveredHeight}`,
);
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
// A keyboard for a field in the page area (like the text field of a view that a page field
// focuses) still makes the page smaller, so the engine keeps the field visible
await tab.evaluate(() => {
  const field = document.createElement('input');
  document.getElementById('pages').append(field);
  field.focus();
  window.blTestField = field;
});
await tab.setViewportSize({ width: PORTRAIT.width, height: 520 });
await tab.waitForTimeout(700);
const pageFieldHeight = await pageHeight();
await tab.evaluate(() => window.blTestField.remove());
await tab.setViewportSize(PORTRAIT);
await tab.waitForTimeout(700);
const backHeight = await pageHeight();
check(
  'page field: the keyboard makes the page smaller, afterwards it is whole again',
  pageFieldHeight < 520 && backHeight === fullHeight,
  `${pageFieldHeight}, ${backHeight}`,
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
// Safari 18 aligns the content of buttons at the start in its own style sheet; a layer stands in
// for it here, below the demo's unlayered rules like a browser style sheet
const safariButtons = await tab.addStyleTag({
  content: '@layer safari18 { button { align-items: flex-start } }',
});
const previews = await tab.evaluate(() =>
  [...document.querySelectorAll('.overview-open')].map((open) => {
    const preview = open.querySelector('.overview-preview').getBoundingClientRect();
    const style = getComputedStyle(open);
    const inner = open.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { preview: preview.width, inner };
  }),
);
check(
  'tab overview: the preview fills the card, also with the button alignment of Safari 18',
  previews.length === 2 && previews.every(({ preview, inner }) => Math.abs(preview - inner) < 1),
  JSON.stringify(previews),
);
await safariButtons.evaluate((node) => node.remove());
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

// Open link in new tab of the context menu: in the background, a message offers to switch to it
await tab.evaluate(() =>
  window.blTest.eval(
    `document.body.insertAdjacentHTML('beforeend', '<a href="four" style="position:fixed;left:0;top:200px;width:200px;height:60px;background:#cde">Four</a>'); console.log('RESULT link=1')`,
  ),
);
await results.wait('link', 10000);
const origin = await canvasOrigin(tab);
// A long press on the link: like Chrome on a phone its address as header and only its commands
if (chromiumOnly('long press on a link (CDP Input.dispatchTouchEvent)')) {
  const cdp = await tab.context().newCDPSession(tab);
  const point = { x: origin.x + 100, y: origin.y + 230 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await tab.waitForTimeout(1000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  const touchMenu = tab.locator('.bl-context-menu[data-bl-touch]');
  await touchMenu.waitFor({ timeout: 10000 }).catch(() => {});
  const rows = await touchMenu
    .locator('.bl-menu-header, .bl-menu-item')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.blItem ?? node.textContent))
    .catch(() => []);
  check(
    'long press on a link: its address as header, no page commands',
    rows.length === 4 &&
      rows[0] === new URL('four', siteURL).href &&
      rows[1] === 'open-link' &&
      rows[2] === 'save-link' &&
      rows[3] === 'copy-link',
    JSON.stringify(rows),
  );
  await screenshot(tab, 'mobile-link-menu');
  await tab.keyboard.press('Escape');
}
await tab.mouse.click(origin.x + 100, origin.y + 230, { button: 'right' });
const openLink = tab.locator('.bl-context-menu button[data-bl-item=open-link]');
await openLink.waitFor({ timeout: 10000 }).catch(() => {});
await openLink.tap();
const snackbarShown = await shown('#snackbar button');
const menuTab = await tab.evaluate(() => ({
  count: document.getElementById('tab-count').textContent.trim(),
  url: window.blTest.view()?.url,
  text: document.getElementById('snackbar').textContent,
}));
check(
  'link from the menu: a background tab and a message to switch',
  snackbarShown &&
    menuTab.count === '2' &&
    menuTab.url.endsWith('/two') &&
    menuTab.text === 'Opened in a new tabSwitch',
  JSON.stringify(menuTab),
);
check('link from the menu: Switch has 44 px', ...(await touchSize('#snackbar button')));
await screenshot(tab, 'mobile-snackbar');
if (snackbarShown) await tab.tap('#snackbar button');
check(
  'link from the menu: Switch brings the new tab to the front',
  await tab
    .waitForFunction(
      () =>
        window.blTest.view()?.url.endsWith('/four') && document.getElementById('snackbar').hidden,
      null,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    ),
);
await tab.tap('#tab-count');
await tab.locator('.overview-card.active .overview-close').tap();
await tab
  .waitForFunction(() => document.querySelectorAll('.overview-card').length === 1, null, {
    timeout: 10000,
  })
  .catch(() => {});
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

// Without the star in the address bar the empty bookmarks sheet points to the menu
await tab.tap('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Bookmarks' }).tap();
const emptyBookmarks = await tab.locator('#side-panel .panel-empty').textContent();
check(
  'bookmarks: the empty sheet names the Bookmark button in the menu',
  emptyBookmarks === 'No bookmarks yet. The Bookmark button in the menu adds one.',
  String(emptyBookmarks),
);
await tab.touchscreen.tap(PORTRAIT.width / 2, 20);

// Find bar over the whole width in place of the toolbar, like Safari and mobile Chrome: the page
// keeps its size and ends above the bar, so a match the engine sees as visible is visible
await tab.evaluate((url) => window.blTest.load(url), `${siteURL}find`);
check('find page', await loaded('Page find'));
const canvasBox = async () => (await boxes('canvas[data-bl-view]')).list[0];
const toolbarBefore = await bar();
const pageBefore = await canvasBox();
await tab.tap('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Find in page' }).tap();
check('find bar opens', await shown('#find-bar'));
check('find bar inside the window', ...(await inside('#find-bar, #find-bar button')));
const findBar = (await boxes('#find-bar')).list[0];
const pageWithFind = await canvasBox();
check(
  'find bar: in place of the toolbar, the page keeps its size and ends above it',
  !(await bar()) &&
    Math.abs(findBar.top - toolbarBefore.top) < 1 &&
    Math.abs(findBar.bottom - PORTRAIT.height) < 1 &&
    Math.abs(pageWithFind.height - pageBefore.height) < 1 &&
    pageWithFind.bottom <= findBar.top + 0.5,
  JSON.stringify([toolbarBefore, findBar, pageBefore, pageWithFind]),
);
await tab.locator('#find-input').fill('zebra');
await tab
  .waitForFunction(() => document.getElementById('find-count').textContent === '1 of 1', null, {
    timeout: 10000,
  })
  .catch(() => {});
results.delete('match');
await tab.evaluate(() =>
  window.blTest.eval(
    "console.log('RESULT match=' + Math.round(getSelection().getRangeAt(0).getBoundingClientRect().bottom))",
  ),
);
const matchBottom = pageWithFind.top + Number(await results.wait('match', 10000));
check(
  'find bar: the match near the bottom of the page is above the bar',
  matchBottom <= findBar.top,
  `match bottom ${matchBottom}, bar top ${findBar.top}`,
);
await screenshot(tab, 'mobile-find');
await tab.tap('#find-close');
check('find bar closed: the toolbar is back', !!(await bar()));
// The address bar from a keyboard (Ctrl+L) ends the find, whose bar hides the toolbar
await tab.tap('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Find in page' }).tap();
await shown('#find-bar');
await tab.locator('#find-input').focus();
await tab.keyboard.press('Control+l');
const addressAfterFind = await tab.evaluate(() => ({
  find: document.getElementById('find-bar').hidden,
  address: document.activeElement?.id,
}));
check(
  'find bar: Ctrl+L closes it and the address bar gets the keyboard',
  addressAfterFind.find && addressAfterFind.address === 'address' && !!(await bar()),
  JSON.stringify(addressAfterFind),
);
await tab.keyboard.press('Escape');

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

// Settings as a full screen sheet: the close button stays at the top while the sheet scrolls
await tab.tap('#menu-button');
await tab.locator('#side-panel .panel-menu-item', { hasText: 'Settings' }).tap();
check('settings open', await shown('#settings'));
// Every section chip shows its whole name on one line, also on a 360 px phone
const chipLabels = () =>
  tab.evaluate(() =>
    [...document.querySelectorAll('#settings nav button')].map((button) => {
      const label = button.lastChild;
      const range = document.createRange();
      range.selectNodeContents(label);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      const cut = label.nodeType === 1 && label.scrollWidth > label.clientWidth;
      return lines.size === 1 && !cut
        ? ''
        : `${button.textContent}: ${lines.size} lines${cut ? ', cut' : ''}`;
    }),
  );
for (const width of [PORTRAIT.width, 360]) {
  await tab.setViewportSize({ width, height: PORTRAIT.height });
  const wrapped = (await chipLabels()).filter(Boolean);
  check(`settings at ${width} px: section names on one line`, !wrapped.length, wrapped.join());
}
await tab.setViewportSize(PORTRAIT);
await tab.tap('#settings nav button[data-section=device]');
const scrolled = await tab.evaluate(() => {
  const sheet = document.getElementById('settings');
  sheet.scrollTop = sheet.scrollHeight;
  return sheet.scrollTop;
});
const closeBox = (await boxes('#settings .settings-close')).list[0];
const onTop = await tab.evaluate(({ left, top, width, height }) => {
  const hit = document.elementFromPoint(left + width / 2, top + height / 2);
  return !!hit?.closest('.settings-close');
}, closeBox);
check(
  'settings scrolled: the close button stays at the top and is what a tap there hits',
  scrolled > 100 && closeBox.top >= 0 && closeBox.top < 20 && onTop,
  JSON.stringify([scrolled, closeBox, onTop]),
);
check('settings: close button of 44 px', ...(await touchSize('#settings .settings-close')));
await screenshot(tab, 'mobile-settings');
await tab.touchscreen.tap(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
check(
  'settings scrolled: a tap on the close button closes them',
  await tab
    .waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    ),
);
await tab.evaluate(() => document.getElementById('settings').close());

// Landscape: still the compact toolbar, sheets fit the low window
await tab.setViewportSize(LANDSCAPE);
check(
  'landscape: compact toolbar',
  await tab.evaluate(() => !document.getElementById('tabs').getClientRects().length),
);
check('landscape: toolbar inside the window', ...(await inside(TOOLBAR)));
const barHeight = await tab.evaluate(() => document.getElementById('toolbar').offsetHeight);
check('landscape: slim toolbar', barHeight <= 46, `${barHeight} px`);
// The view paints in the new size after a moment
await tab.waitForTimeout(1500);
await screenshot(tab, 'mobile-landscape');

// Like Chrome the bar slides away while the user scrolls the page down and comes back when they
// scroll up or the page is at its top; the page takes its room (#472)
await tab.evaluate((url) => window.blTest.load(url), `${siteURL}long`);
check('long page', await loaded('Page long'));
const barState = () => tab.evaluate(() => document.body.dataset.bar ?? 'shown');
const waitBar = (state, ms = 10000) =>
  tab
    .waitForFunction((state) => (document.body.dataset.bar ?? 'shown') === state, state, {
      timeout: ms,
    })
    .then(
      () => true,
      () => false,
    );
const cdp = BROWSER === 'chromium' ? await context.newCDPSession(tab) : null;
/** The user scrolls the page by dy (down when positive): a finger in Chromium, else the wheel. */
async function userScroll(dy) {
  const [x, y] = [LANDSCAPE.width / 2, 180];
  if (!cdp) {
    await tab.mouse.move(x, y);
    await tab.mouse.wheel(0, dy);
    return;
  }
  const steps = 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await tab.waitForTimeout(30);
    const point = { x, y: y - (dy * i) / steps };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  }
  // Still before lifting: no fling
  await tab.waitForTimeout(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const shownHeight = await pageHeight();
await tab.evaluate(() => window.blTest.eval('scrollTo(0, 600)'));
await tab.waitForTimeout(1000);
check('bar: a scroll by the page itself keeps it', (await barState()) === 'shown');
await userScroll(150);
check('bar: scrolling down hides it', await waitBar('hidden'));
const hiddenBar = await bar();
const hiddenArea = (await boxes('#viewport')).list[0];
check(
  'bar hidden: below the window, the page area down to the bottom',
  !!hiddenBar &&
    hiddenBar.top >= LANDSCAPE.height - 0.5 &&
    Math.abs(hiddenArea.bottom - LANDSCAPE.height) < 1,
  JSON.stringify([hiddenBar, hiddenArea]),
);
check(
  'bar hidden: the demo itself does not scroll',
  await tab.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight),
);
await tab.waitForTimeout(700);
const hiddenHeight = await pageHeight();
check(
  'bar hidden: the page gets its room',
  hiddenHeight === LANDSCAPE.height && shownHeight === LANDSCAPE.height - barHeight,
  `${shownHeight} -> ${hiddenHeight}`,
);
await userScroll(150);
await tab.waitForTimeout(500);
check('bar: scrolling on down keeps it hidden', (await barState()) === 'hidden');
// With motion: the bar slides in over the page and gives the room back once it is there
await tab.emulateMedia({ reducedMotion: 'no-preference' });
await tab.evaluate(() => {
  window.barStates = [];
  new MutationObserver(() => {
    const area = document.getElementById('viewport').getBoundingClientRect();
    window.barStates.push(`${document.body.dataset.bar ?? 'shown'}:${Math.round(area.bottom)}`);
  }).observe(document.body, { attributes: true, attributeFilter: ['data-bar'] });
});
await userScroll(-100);
check('bar: scrolling up shows it', await waitBar('shown'));
const states = await tab.evaluate(() => window.barStates.join(','));
check(
  'bar: it slides in over the page first, then takes its room',
  states === `showing:${LANDSCAPE.height},shown:${LANDSCAPE.height - barHeight}`,
  states,
);
await tab.waitForTimeout(700);
check('bar shown: the page gives the room back', (await pageHeight()) === shownHeight);
await tab.emulateMedia({ reducedMotion: 'reduce' });
await userScroll(150);
check('bar: hidden again', await waitBar('hidden'));
await tab.evaluate(() => window.blTest.eval('scrollTo(0, 0)'));
check('bar: back at the top of the page', await waitBar('shown'));
// Like Chrome's controls while a page loads, a navigation of the page itself (a tapped link)
// brings the bar with its progress back at once, also while the page left still loads, and it
// stays until the new document commits
await tab.evaluate((url) => window.blTest.load(url), `${siteURL}long-loading`);
check('page that still loads', await loaded('Page long-loading'));
// The first position after a commit only sets the start (one wheel step is one scroll event)
await tab.evaluate(() => window.blTest.eval('scrollTo(0, 600)'));
await userScroll(150);
check('bar: hidden while the page loads', await waitBar('hidden'));
await tab.evaluate(
  (url) => window.blTest.eval(`location.href = ${JSON.stringify(url)}`),
  `${siteURL}slow`,
);
check('bar: a navigation of the page shows it at once', await waitBar('shown', 1500));
await userScroll(150);
await tab.waitForTimeout(300);
check(
  'bar: it stays while the navigation is pending',
  (await barState()) === 'shown' && results.get('loaded') !== 'Page slow',
  `${await barState()}, ${results.get('loaded')}`,
);
check('slow page', await loaded('Page slow'));
await tab.evaluate(() => window.blTest.eval('scrollTo(0, 600)'));
await userScroll(150);
check('bar: scrolling hides it again after the commit', await waitBar('hidden'));
await tab.evaluate(() => window.blTest.eval('scrollTo(0, 0)'));
check('bar: back at the top of the new page', await waitBar('shown'));
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

// Print without a PDF viewer in the host: a message and Save as PDF instead of a placeholder
await tab.evaluate(() => window.blTest.eval('window.print()'));
const printMessage = await tab
  .locator('#print-preview:not([hidden]) .print-message')
  .waitFor({ timeout: 20000 })
  .then(
    () => true,
    () => false,
  );
const printButtons = await tab.evaluate(() =>
  ['.print-now', '.print-save', 'iframe']
    .map((s) => !!document.querySelector(`#print-preview ${s}`)?.getClientRects().length)
    .join(','),
);
check(
  'print without a PDF viewer: message and Save as PDF only',
  printMessage && printButtons === 'false,true,false',
  printButtons,
);
await tab.tap('#print-preview .print-close');

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
