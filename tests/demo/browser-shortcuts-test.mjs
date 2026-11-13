// Chrome's shortcuts that the page does not handle: Ctrl+K and Ctrl+E put `?` into the address
// bar, so what follows is only a search (also text that looks like an address); Ctrl+S saves the
// page with a request of its own as `<title>.html`, the characters a file name cannot have
// replaced; Ctrl+Shift+Delete opens the profile and site data at Delete site data; Alt+Home loads
// the new tab page, or the home page of the settings, in the active tab.
//
//   node tests/demo/browser-shortcuts-test.mjs [engine-dir]
import { readFileSync } from 'node:fs';
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Keys: "one" / two</title><body style="height:2000px"><p>keys
<script>console.log('RESULT ready=start')</script>`;
const HOME = `<!doctype html><title>Home</title><p>home<script>console.log('RESULT ready=home')</script>`;
let pageRequests = 0;
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') pageRequests++;
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url === '/home' ? HOME : PAGE);
});

const stack = await startStack({ app: 'demo', token: 'browser-shortcuts-token-0123456789ab' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
const hostDownloads = [];
page.on('download', (download) => hostDownloads.push(download));
await page.goto(stack.app({ url: siteURL }));
check('page loaded', (await results.wait('ready', TIMEOUT)) === 'start');
const box = await canvasOrigin(page);

async function pressInPage(combo) {
  await page.mouse.click(box.x + 300, box.y + 300);
  await page.waitForTimeout(300);
  await page.keyboard.press(combo);
  await page.waitForTimeout(500);
}
const field = () =>
  page.evaluate(() => {
    const address = document.getElementById('address');
    return {
      active: document.activeElement?.id ?? '',
      value: address.value,
      rows: [...document.querySelectorAll('#suggestions:not([hidden]) .suggestion-title')].map(
        (row) => row.textContent,
      ),
    };
  });
const viewURL = () => page.evaluate(() => window.blTest.view().url);

// Ctrl+K and Ctrl+E: a search in the address bar, an address after `?` is searched too
for (const combo of ['Control+k', 'Control+e']) {
  await pressInPage(combo);
  await page
    .waitForFunction(() => document.activeElement?.id === 'address', null, { timeout: 5000 })
    .catch(() => {});
  const opened = await field();
  check(
    `${combo}: the address bar has the keyboard with ?`,
    opened.active === 'address' && opened.value === '?',
    JSON.stringify(opened),
  );
  await page.keyboard.type('example.com');
  const typed = await field();
  check(
    `${combo}: after ? only the search is offered`,
    typed.value === '?example.com' &&
      typed.rows.length === 1 &&
      /^Search .* for "example\.com"$/.test(typed.rows[0] ?? ''),
    JSON.stringify(typed),
  );
  await page.keyboard.press('Escape');
}

// Ctrl+S: Save page as, named after the title, the page requested again
const requestsBefore = pageRequests;
await pressInPage('Control+s');
await waitFor(() => hostDownloads.length > 0, 20000);
const saved = hostDownloads[0];
check(
  'Ctrl+S: the page is saved as <title>.html',
  saved?.suggestedFilename() === 'Keys_ _one_ _ two.html',
  saved?.suggestedFilename(),
);
check(
  'Ctrl+S: with the content of the page, requested again',
  !!saved && readFileSync(await saved.path(), 'utf8') === PAGE && pageRequests > requestsBefore,
  `${pageRequests - requestsBefore} requests`,
);

// Ctrl+Shift+Delete: the settings at the profile and site data
await pressInPage('Control+Shift+Delete');
const clear = await page.evaluate(() => ({
  open: document.getElementById('settings')?.open ?? false,
  section: document.querySelector('#settings nav [aria-current]')?.dataset.section,
  hasButton: !!document.getElementById('settings-clear-site-data'),
  focus:
    document.activeElement?.id || (document.activeElement?.dataset?.section ?? '') || 'nothing',
  disabled: document.getElementById('settings-clear-site-data')?.disabled,
}));
check(
  'Ctrl+Shift+Delete: profile and site data at Delete site data',
  clear.open &&
    clear.section === 'profile' &&
    clear.hasButton &&
    (clear.focus === 'settings-clear-site-data' || (clear.disabled && clear.focus === 'profile')),
  JSON.stringify(clear),
);

// Set a home page while the settings are open
await page.click('#settings nav [data-section=general]');
await page.fill('#setting-home', `${siteURL}home`);
await page.keyboard.press('Tab');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Alt+Home: the home page in the active tab
await pressInPage('Alt+Home');
check('Alt+Home loads the home page in the tab', (await results.wait('ready')) === 'home');
const tabs = await page.locator('#tab-list .tab').count();
check('Alt+Home stays in the tab', tabs === 1, `${tabs} tabs`);

// Without a home page: the new tab page
await page.click('#menu-button');
await page.click('#side-panel .panel-menu-item:has-text("Settings")');
await page.fill('#setting-home', '');
await page.keyboard.press('Tab');
await page.keyboard.press('Escape');
await pressInPage('Alt+Home');
const blank = await waitFor(async () => (await viewURL()) === 'about:blank#new-tab', 10000);
check('Alt+Home without a home page: the new tab page', blank, await viewURL());

// Enter after ? searches with the search engine; the view only records the address
await page.evaluate(() => {
  window.blTest.view().load = (url) => {
    window.loadedAddress = url;
  };
});
await page.click('#address');
await page.fill('#address', '');
await page.keyboard.type('?example.com');
await page.keyboard.press('Enter');
const searched = await page.evaluate(() => window.loadedAddress ?? '');
check(
  'Enter after ? searches for the rest',
  searched.includes('q=example.com') && !searched.includes('%3F'),
  searched,
);

await browser.close();
finish();
