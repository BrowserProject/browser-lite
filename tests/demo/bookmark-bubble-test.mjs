// The bookmark bubble like Chrome: Ctrl+D and the star bookmark the page and open "Bookmark added"
// with its name selected, again on a bookmarked page "Edit bookmark" without removing it; Enter,
// Done, Escape and a click outside keep the bookmark with the name typed, the star closes the
// bubble again, Remove removes it, and the page has the keyboard afterwards. In the phone layout
// the Bookmark button of the menu opens the bubble inside the window without the keyboard.
//
//   node tests/demo/bookmark-bubble-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const page = (title) =>
  `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="height:2000px"><h1>${title}</h1><script>console.log('RESULT ready=' + document.title)</script>`;
const { url: siteURL } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(page(req.url === '/phone' ? 'Phone page' : 'Star page')),
);

const stack = await startStack({ app: 'demo', token: 'bookmark-bubble-token-0123456789ab' });
const browser = await launch();

const bubbleState = (tab) =>
  tab.evaluate(() => {
    const bubble = document.getElementById('bookmark-bubble');
    const field = document.getElementById('bookmark-name');
    const star = document.getElementById('bookmark');
    return {
      open: !!bubble?.matches(':popover-open'),
      title: document.getElementById('bookmark-bubble-title')?.textContent,
      name: field?.value,
      fieldFocused: !!field && document.activeElement === field,
      selected: field?.selectionStart === 0 && field.selectionEnd === field.value.length,
      star: star.getAttribute('aria-label'),
      bookmarks: (window.blTest.profile.prefs('bookmarks') ?? []).map((entry) => entry.title),
      pageFocused: !!window.blTest.view()?.focused,
    };
  });
const isOpen = (tab, open) =>
  tab
    .waitForFunction(
      (open) => !!document.getElementById('bookmark-bubble')?.matches(':popover-open') === open,
      open,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
const pageFocused = (tab) =>
  waitFor(() => tab.evaluate(() => !!window.blTest.view()?.focused), 5000);

// Desktop
const desktop = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const tab = await desktop.newPage();
const results = collect(tab, /RESULT (\w+)=(.*?)(\s+\(|$)/);
await tab.goto(stack.app({ url: siteURL }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === 'Star page');
// The title reaches the tab with its own event, after the page's script ran
await tab.waitForFunction(
  () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Star page',
  null,
  { timeout: TIMEOUT },
);
const box = await canvasOrigin(tab);
const clickPage = async () => {
  await tab.mouse.click(box.x + 300, box.y + 300);
  await pageFocused(tab);
};

await clickPage();
await tab.keyboard.press('Control+d');
check('Ctrl+D opens the bubble', await isOpen(tab, true));
await tab
  .waitForFunction(
    () => document.activeElement === document.getElementById('bookmark-name'),
    null,
    {
      timeout: 5000,
    },
  )
  .catch(() => {});
let state = await bubbleState(tab);
check(
  'Ctrl+D: Bookmark added, the name selected, the star edits',
  state.title === 'Bookmark added' &&
    state.name === 'Star page' &&
    state.fieldFocused &&
    state.selected &&
    state.star === 'Edit bookmark' &&
    JSON.stringify(state.bookmarks) === '["Star page"]',
  JSON.stringify(state),
);
await screenshot(tab, 'bookmark-bubble-added');

await tab.keyboard.type('Renamed');
await tab.keyboard.press('Enter');
check('Enter closes the bubble', await isOpen(tab, false));
state = await bubbleState(tab);
check(
  'Enter keeps the bookmark with the name typed',
  JSON.stringify(state.bookmarks) === '["Renamed"]',
  JSON.stringify(state),
);
check('the page has the keyboard after Enter', await pageFocused(tab));

await tab.keyboard.press('Control+d');
check('Ctrl+D on a bookmarked page opens the bubble', await isOpen(tab, true));
state = await bubbleState(tab);
check(
  'Ctrl+D on a bookmarked page: Edit bookmark, the bookmark stays',
  state.title === 'Edit bookmark' &&
    state.name === 'Renamed' &&
    state.star === 'Edit bookmark' &&
    JSON.stringify(state.bookmarks) === '["Renamed"]',
  JSON.stringify(state),
);
await tab.keyboard.press('Control+d');
await tab.waitForTimeout(300);
state = await bubbleState(tab);
check(
  'Ctrl+D while the bubble is open changes nothing',
  state.open && JSON.stringify(state.bookmarks) === '["Renamed"]',
  JSON.stringify(state),
);
await tab.keyboard.press('Escape');
check('Escape closes the bubble', await isOpen(tab, false));
check(
  'Escape keeps the bookmark',
  JSON.stringify((await bubbleState(tab)).bookmarks) === '["Renamed"]',
);
check('the page has the keyboard after Escape', await pageFocused(tab));

await tab.click('#bookmark');
check('the star opens the bubble', await isOpen(tab, true));
check('star: Edit bookmark', (await bubbleState(tab)).title === 'Edit bookmark');
await tab.click('#bookmark');
check('the star closes it again', await isOpen(tab, false));
check(
  'the star keeps the bookmark',
  JSON.stringify((await bubbleState(tab)).bookmarks) === '["Renamed"]',
);

await tab.click('#bookmark');
check('star opens the bubble before Remove', await isOpen(tab, true));
await tab.click('#bookmark-bubble .bookmark-remove');
check('Remove closes the bubble', await isOpen(tab, false));
state = await bubbleState(tab);
check(
  'Remove removes the bookmark',
  state.bookmarks.length === 0 && state.star === 'Bookmark this page',
  JSON.stringify(state),
);

await tab.click('#bookmark');
check('the star on a page without bookmark opens the bubble', await isOpen(tab, true));
await tab.keyboard.type('Clicked away');
await tab.mouse.click(box.x + 300, box.y + 300);
check('a click into the page closes the bubble', await isOpen(tab, false));
state = await bubbleState(tab);
check(
  'a click outside keeps the bookmark with the name typed',
  JSON.stringify(state.bookmarks) === '["Clicked away"]',
  JSON.stringify(state),
);
await desktop.close();

// Phone layout: the Bookmark button of the menu
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const mobile = await phone.newPage();
const mobileResults = collect(mobile, /RESULT (\w+)=(.*?)(\s+\(|$)/);
await mobile.goto(stack.app({ url: `${siteURL}phone` }));
check('phone: page loaded', (await mobileResults.wait('ready', TIMEOUT)) === 'Phone page');
await mobile.locator('#menu-button').tap();
await mobile.locator('#side-panel .panel-icon', { hasText: 'Bookmark' }).tap();
check('phone: the Bookmark button opens the bubble', await isOpen(mobile, true));
const placed = await mobile.evaluate(() => {
  const rect = document.getElementById('bookmark-bubble').getBoundingClientRect();
  return {
    inside:
      rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    title: document.getElementById('bookmark-bubble-title').textContent,
    fieldFocused: document.activeElement === document.getElementById('bookmark-name'),
  };
});
check(
  'phone: Bookmark added inside the window, no keyboard',
  placed.inside && placed.title === 'Bookmark added' && !placed.fieldFocused,
  JSON.stringify(placed),
);
await screenshot(mobile, 'bookmark-bubble-phone');
await mobile.locator('#bookmark-bubble .bookmark-done').tap();
check('phone: Done closes the bubble', await isOpen(mobile, false));
check(
  'phone: the bookmark is kept',
  (await mobile.evaluate(() =>
    window.blTest.profile.prefs('bookmarks')?.some((entry) => entry.title === 'Phone page'),
  )) === true,
);

await browser.close();
finish();
