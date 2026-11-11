// The icon in front of each tab like Chrome: a page without a favicon, or with one that does not
// decode, shows a globe, and once many tabs have made the tabs too narrow for their titles every
// background tab still shows its icon instead of an empty box.
//
//   node tests/demo/tab-icons-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT * 3);

const TABS = 18;
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#00c"/></svg>';
const ready = (name) => `<script>console.log('RESULT ready=${name}')</script>`;
const { url: siteURL } = await serve((req, res) => {
  const html = (body) =>
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html>${body}`);
  if (req.url === '/good.svg')
    return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(ICON);
  if (req.url === '/broken.png')
    return res.writeHead(200, { 'Content-Type': 'image/png' }).end('not an image');
  if (req.url === '/good')
    return html(`<title>Good</title><link rel="icon" href="/good.svg">${ready('good')}`);
  if (req.url === '/broken')
    return html(`<title>Broken</title><link rel="icon" href="/broken.png">${ready('broken')}`);
  const page = /^\/p(\d+)$/.exec(req.url);
  // No icon: /favicon.ico is a 404 as well
  if (page) return html(`<title>Page ${page[1]}</title><p>${page[1]}${ready(page[1])}`);
  res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'icons-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const results = collect(page);
async function go(address, name) {
  results.delete('ready');
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
  await results.wait('ready', TIMEOUT);
  check(`page ${name} loaded`, results.get('ready') === name, results.get('ready'));
}
/** What each tab shows: its width, the kind of icon and which parts are visible. */
const tabs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab')].map((tab) => {
      const shown = (selector) => {
        const part = tab.querySelector(selector);
        if (!part) return false;
        const box = part.getBoundingClientRect();
        return getComputedStyle(part).display !== 'none' && box.width > 0 && box.height > 0;
      };
      const slot = tab.querySelector('.icon');
      return {
        width: Math.round(tab.getBoundingClientRect().width),
        active: tab.classList.contains('active'),
        icon: slot?.querySelector('img') ? 'img' : slot?.querySelector('svg') ? 'globe' : 'none',
        iconShown: shown('.icon > *'),
        title: shown('.title'),
        close: shown('.close'),
      };
    }),
  );
const activeIs = (icon) =>
  page
    .waitForFunction(
      (icon) => {
        const part = document.querySelector('#tab-list .tab.active .icon > *');
        const box = part?.getBoundingClientRect();
        return part?.localName === icon && box.width > 0 && (icon !== 'img' || part.naturalWidth);
      },
      icon,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );

await page.goto(stack.app({ url: `${siteURL}p1` }));
await results.wait('ready', TIMEOUT);

// 1) A page without a favicon: the globe in front of its title
check('page without a favicon: a globe', await activeIs('svg'), JSON.stringify(await tabs()));

// 2) A favicon that does not decode: the globe instead of the icon the site showed before
await go(`${siteURL}good`, 'good');
check('page with a favicon: its icon', await activeIs('img'), JSON.stringify(await tabs()));
await go(`${siteURL}broken`, 'broken');
check('favicon that does not decode: a globe', await activeIs('svg'), JSON.stringify(await tabs()));

// 3) Many tabs: below 64 px the titles give way, every background tab keeps its icon
for (let i = 2; i <= TABS; i++) {
  await page.keyboard.press('Control+t');
  await go(`${siteURL}p${i}`, String(i));
}
const strip = await tabs();
const background = strip.filter((tab) => !tab.active);
check(
  `${TABS} tabs are narrower than their titles need`,
  strip.length === TABS && strip.every((tab) => tab.width < 64 && !tab.title),
  JSON.stringify(strip.map((tab) => tab.width)),
);
check(
  'every narrow background tab shows its icon',
  background.length === TABS - 1 && background.every((tab) => tab.iconShown),
  JSON.stringify(background),
);
check(
  'the narrow active tab shows its cross',
  strip.find((tab) => tab.active)?.close === true,
  JSON.stringify(strip.find((tab) => tab.active)),
);

await browser.close();
finish();
