// The menu and the side panels share one scroll container (#side-panel). A panel opened from
// another one starts at its top like a panel opened anew: History tapped in a scrolled menu sheet
// on a phone showed its title and close button above the sheet, scrolled by the menu's offset.
// The desktop dropdown menu does the same.
//
//   node tests/demo/panel-switch-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const { url: siteURL } = await serve((_req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end('<!doctype html><meta name="viewport" content="width=device-width"><title>Start</title>'),
);

const stack = await startStack({ app: 'demo', token: 'panelswitch-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 560 },
  hasTouch: true,
  isMobile: process.env.BL_BROWSER === 'firefox' ? undefined : true,
});
const page = await context.newPage();
watchErrors(page);

await page.goto(stack.app({ url: `${siteURL}start` }));
await page.waitForSelector('#address', { timeout: TIMEOUT });

// Enough visits that the list is taller than the sheet
await page.evaluate((siteURL) => {
  const now = Date.now();
  const pages = Array.from({ length: 40 }, (_, i) => ({
    url: `${siteURL}page-${i}`,
    title: `Page ${i}`,
    time: now - (40 - i) * 60000,
  }));
  localStorage.setItem('bl-history', JSON.stringify(pages));
}, siteURL);

const state = () =>
  page.evaluate(() => {
    const panel = document.getElementById('side-panel');
    const header = panel.querySelector('header');
    return {
      panel: panel.dataset.panel,
      scrollTop: panel.scrollTop,
      panelTop: Math.round(panel.getBoundingClientRect().top),
      headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
    };
  });
const scrollPanel = (top) =>
  page.evaluate((top) => {
    const panel = document.getElementById('side-panel');
    panel.scrollTop = top;
    return panel.scrollTop;
  }, top);

// Phone: History from a scrolled menu sheet
await page.locator('#menu-button').tap();
await page.waitForSelector('#side-panel[data-panel="menu"]:not([hidden])');
const menuScrolled = await scrollPanel(60);
check('phone: the menu sheet scrolls', menuScrolled > 0, String(menuScrolled));
await page.locator('#side-panel .panel-menu-item', { hasText: 'History' }).tap();
await page.waitForSelector('#side-panel[data-panel="history"]');
const history = await state();
check(
  'phone: History from a scrolled menu starts at its top, title and close button visible',
  history.scrollTop === 0 && history.headerTop !== null && history.headerTop >= history.panelTop,
  JSON.stringify(history),
);

await page.locator('#side-panel .panel-close').tap();
check(
  'phone: History closes',
  await waitFor(() => page.evaluate(() => document.getElementById('side-panel').hidden), 5000),
);

// Desktop: History from a scrolled dropdown menu
await page.setViewportSize({ width: 1000, height: 300 });
await page.click('#menu-button');
await page.waitForSelector('#side-panel[data-panel="menu"]:not([hidden])');
const dropdownScrolled = await scrollPanel(60);
check('desktop: the dropdown menu scrolls', dropdownScrolled > 0, String(dropdownScrolled));
await page.click('#side-panel .panel-menu-item:has-text("History")');
await page.waitForSelector('#side-panel[data-panel="history"]');
const desktop = await state();
check(
  'desktop: History from a scrolled menu starts at its top',
  desktop.scrollTop === 0 && desktop.headerTop !== null && desktop.headerTop >= desktop.panelTop,
  JSON.stringify(desktop),
);

await browser.close();
finish();
