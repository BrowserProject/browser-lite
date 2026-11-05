// Pop-up blocker like Chrome: window.open and a target=_blank link without a user gesture do not
// open, an icon in the address bar counts them, its bubble lists them, opens one in a new tab and
// allows popups for the site (then they open as tabs); a click opens a popup as before.
//
//   node tests/demo/popups-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Opener</title>
<a id="link" href="/popup.html?link" target="_blank">link</a>
<script>console.log('RESULT ready=1')</script>`;
const POPUP = `<!doctype html><title>Popup</title>
<script>console.log('RESULT popup=' + location.search)</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else if (req.url.startsWith('/popup.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'popups-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);
const tabCount = () => page.evaluate(() => document.querySelectorAll('#tab-list .tab').length);
// Script in the active view without a user gesture (from a timer)
const run = (source) =>
  page.evaluate((source) => window.blTest.eval(`setTimeout(() => { ${source} }, 0)`), source);
const iconLabel = () =>
  page.waitForSelector('#popups:not([hidden])', { timeout: 10000 }).then(
    () => page.evaluate(() => document.getElementById('popups').getAttribute('aria-label')),
    () => null,
  );

await page.goto(stack.app({ url: siteURL }));
check('page ready', (await result('ready', TIMEOUT)) === '1');
check('no icon without a blocked popup', await page.locator('#popups').isHidden());

// 1) window.open from a timer: null for the page, the icon appears, no tab
await run('console.log("RESULT open=" + (window.open("/popup.html?open") ? "window" : "null"))');
check('window.open without a gesture returns null', (await result('open')) === 'null');
check('blocked popup: icon in the address bar', (await iconLabel()) === 'Pop-up blocked');
if (!(await page.locator('#popups').isVisible())) {
  await browser.close();
  finish();
}

// 2) A target=_blank link clicked by script: blocked as well
await run('document.getElementById("link").click(); console.log("RESULT clicked=1")');
await result('clicked');
const label = await page
  .waitForFunction(
    () => document.getElementById('popups').getAttribute('aria-label') === '2 pop-ups blocked',
    null,
    { timeout: 10000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'scripted link click blocked too',
  label && (await tabCount()) === 1,
  `${await tabCount()} tabs`,
);

// 3) The bubble lists both; a click on one opens it in a new tab
await page.click('#popups');
const entries = await page.waitForSelector('#popup-bubble .popup-entry', { timeout: 10000 }).then(
  () => page.locator('#popup-bubble .popup-entry').allTextContents(),
  () => [],
);
check(
  'bubble lists the blocked popups',
  entries.join(' ') === `${siteURL}popup.html?open ${siteURL}popup.html?link`,
  JSON.stringify(entries),
);
const host = new URL(siteURL).host;
const bubble = await page.evaluate(() => ({
  title: document.querySelector('#popup-bubble .popup-title')?.textContent,
  allow: document.querySelector('#popup-bubble .popup-allow')?.textContent,
}));
check(
  'bubble names the site and offers to allow it',
  bubble.title === `Pop-ups blocked on ${host}` && bubble.allow === 'Always allow',
  JSON.stringify(bubble),
);
await screenshot(page, 'demo-popups');
await page.locator('#popup-bubble .popup-entry').first().click();
check(
  'blocked popup opened from the bubble in a new tab',
  (await result('popup')) === '?open' && (await tabCount()) === 2,
  `${await tabCount()} tabs`,
);
results.delete('popup');
await page.click('#tab-list .tab:first-child .title');
check('the other one is still listed', (await iconLabel()) === 'Pop-up blocked');

// 4) Always allow: the icon goes, popups of the site open from then on
await page.click('#popups');
await page.click('#popup-bubble .popup-allow');
check(
  'allowed: icon hidden',
  await page.waitForSelector('#popups', { state: 'hidden', timeout: 10000 }).then(
    () => true,
    () => false,
  ),
);
await run(
  'console.log("RESULT allowed=" + (window.open("/popup.html?allowed") ? "window" : "null"))',
);
check(
  'allowed site opens popups without a gesture',
  (await result('allowed')) === 'window' && (await result('popup')) === '?allowed',
  `${results.get('allowed')} ${results.get('popup')}`,
);
check('allowed popup as a new tab', (await tabCount()) === 3, `${await tabCount()} tabs`);

await browser.close();
finish();
