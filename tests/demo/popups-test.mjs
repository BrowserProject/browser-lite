// Pop-up blocker like Chrome: window.open and a target=_blank link without a user gesture do not
// open, an icon in the address bar counts them, its bubble lists them, opens one in a new tab and
// allows popups for the site (then they open as tabs); a click opens a popup as before. Like
// Chrome a click lets the page open one popup within 5 s (transient activation), also from a timer
// after the 1 s a user gesture reaches.
//
//   node tests/demo/popups-test.mjs [engine-dir]
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
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Opener</title>
<a id="link" href="/popup.html?link" target="_blank">link</a>
<script>console.log('RESULT ready=1')</script>`;
const POPUP = `<!doctype html><title>Popup</title>
<script>console.log('RESULT popup=' + location.search)</script>`;

// One button per delay: after the delay one window.open, the second open shows that the first
// used up the activation
const delayed = (id, top, ms) =>
  `<button id="${id}" style="top:${top}px" onclick="setTimeout(() => console.log('RESULT ${id}=' + [window.open('/popup.html?${id}'), window.open('/popup.html?${id}2')].map((w) => (w ? 'window' : 'null'))), ${ms})">${id}</button>`;
const LATE = `<!doctype html><title>Late</title>
<style>body{margin:0} button{position:absolute;left:20px;width:200px;height:40px}</style>
${delayed('expired', 20, 6000)}${delayed('late', 80, 2000)}
<script>console.log('RESULT ready=1')</script>`;

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

// 5) Another site, clicked for real: a click 6 s ago no longer opens a popup, one 2 s ago does
// (once); the user gesture alone reaches timers for 1 s only
const { url: lateURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LATE);
  else if (req.url.startsWith('/popup.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  else res.writeHead(404).end();
});
const latePage = await (
  await browser.newContext({ viewport: { width: 1000, height: 700 } })
).newPage();
const late = collect(latePage, /RESULT (\w+)=(.*?)(\s+\(|$)/);
await latePage.goto(stack.app({ url: lateURL }));
check('late page ready', (await late.wait('ready', TIMEOUT)) === '1');
const clickButton = async (y) => {
  const origin = await canvasOrigin(latePage);
  await latePage.mouse.click(origin.x + 100, origin.y + y);
};
await clickButton(40);
check(
  'click 6 s before window.open: blocked',
  (await late.wait('expired', 30000)) === 'null,null',
  late.get('expired'),
);
await clickButton(100);
check(
  'click 2 s before window.open: one popup, the activation is used up',
  (await late.wait('late', 30000)) === 'window,null' && (await late.wait('popup')) === '?late',
  `${late.get('late')} ${late.get('popup')}`,
);

await browser.close();
finish();
