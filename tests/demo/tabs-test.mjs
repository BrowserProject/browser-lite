// The tab strip and the toolbar of the demo (the engine side is in tests/core): the speaker in the
// tab appears with sound and mutes the tab on a click, the recording indicator follows the camera,
// the favicon of the page in the tab, the address bar keeps an address that failed, the security
// indicator ("Not secure" for a certificate error, nothing on other error pages) and the back
// button.
//
//   node tests/demo/tabs-test.mjs [engine-dir]
import https from 'node:https';
import path from 'node:path';
import { makeCerts } from '../fixtures/certs.mjs';
import {
  SWIFTSHADER,
  TIMEOUT,
  buildDir,
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

timeLimit(TIMEOUT + 120000);

const PAGES = {
  '/sound': `<!doctype html><title>Sound</title><body style="margin:0;height:100vh;background:#eef">Sound<script>
document.addEventListener('click', () => {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.5;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  console.log('RESULT sound=1');
});
console.log('RESULT ready=sound');
</script>`,
  '/camera': `<!doctype html><title>Camera</title><body style="margin:0;height:100vh">Camera<script>
let stream = null;
document.addEventListener('click', async () => {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    console.log('RESULT camera=stopped');
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({ video: true });
  console.log('RESULT camera=on');
});
console.log('RESULT ready=camera');
</script>`,
  '/icon': `<!doctype html><title>Icon</title><link rel="icon" href="/icon.svg"><p>Icon<script>console.log('RESULT ready=icon')</script>`,
};
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/icon.svg')
    return res
      .writeHead(200, { 'Content-Type': 'image/svg+xml' })
      .end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0a0"/></svg>',
      );
  const page = PAGES[req.url];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
});
// A server with a self-signed certificate: the engine shows its certificate error page
const certs = makeCerts(path.join(buildDir, 'e2e-certs'));
const selfSigned = https.createServer(certs.selfSigned, (req, res) =>
  res.writeHead(200).end('never'),
);
await new Promise((resolve) => selfSigned.listen(0, '127.0.0.1', resolve));
const selfSignedURL = `https://127.0.0.1:${selfSigned.address().port}/`;

const stack = await startStack({ app: 'demo', token: 'tabs-token-0123456789abcdef' });
const browser = await launch({
  args: [...SWIFTSHADER, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: ['camera', 'microphone'],
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms = 30000) => results.wait(key, ms);
async function go(address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
const clickPage = async () => {
  const box = await canvasOrigin(page);
  await page.mouse.click(box.x + 100, box.y + 100);
};

// 1) Speaker in the tab like Chrome: appears with sound, a click mutes the tab
await page.goto(stack.app({ url: `${siteURL}sound` }));
check('page with sound loaded', (await result('ready', TIMEOUT)) === 'sound');
await clickPage();
await result('sound');
const audioButton = page.locator('#tab-list .tab.active .audio:not([hidden])');
check(
  'speaker in the tab',
  await audioButton.waitFor({ timeout: 10000 }).then(
    () => true,
    () => false,
  ),
);
const peakUntil = async (done) => {
  let peak = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    peak = (await page.evaluate(() => window.blTest.audioState())).peak;
    if (done(peak)) break;
  }
  return peak;
};
check('sound reaches the host', (await peakUntil((peak) => peak > 0.3)) > 0.3);
await audioButton.click();
const mutedPeak = await peakUntil((peak) => peak <= 0.01);
check('tab muted: no more sound', mutedPeak <= 0.01, String(mutedPeak));
await audioButton.click();
const unmutedPeak = await peakUntil((peak) => peak > 0.3);
check('sound on again', unmutedPeak > 0.3, String(unmutedPeak));

// 2) Recording indicator in the tab while the camera runs
results.delete('ready');
await go(`${siteURL}camera`);
await result('ready');
await clickPage();
const prompt = page.locator('.bl-permission-prompt:not([hidden])');
if (
  await prompt.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  )
)
  await prompt.locator('button', { hasText: 'Allow' }).click();
check('camera on', (await result('camera')) === 'on', results.get('camera'));
check(
  'recording indicator in the tab',
  await page
    .locator('#tab-list .tab.active .recording:not([hidden])')
    .waitFor({ timeout: 10000 })
    .then(
      () => true,
      () => false,
    ),
);
results.delete('camera');
await clickPage();
check('camera stopped', (await result('camera')) === 'stopped');
check(
  'recording indicator off',
  await page
    .locator('#tab-list .tab.active .recording[hidden]')
    .waitFor({ state: 'attached', timeout: 10000 })
    .then(
      () => true,
      () => false,
    ),
);

// 3) Favicon: the engine loads it, the demo shows it in the tab
await go(`${siteURL}icon`);
const icon = await page
  .waitForFunction(
    () => {
      const img = document.querySelector('.tab.active .icon');
      return img && !img.hidden && img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
    },
    null,
    { timeout: 20000 },
  )
  .then(
    (handle) => handle.jsonValue(),
    () => 0,
  );
check('favicon in the tab', icon > 0, `(width ${icon})`);
await screenshot(page, 'demo-tabs');

// 4) Failing navigations: the address bar keeps the address, the security indicator says
// "Not secure" only for a certificate error
const address = () => page.inputValue('#address');
const security = () =>
  page.evaluate(() => ({
    text: document.getElementById('security').textContent,
    hidden: document.getElementById('security').hidden,
  }));
await go('http://nonexistent.invalid/');
await page
  .waitForFunction(() => document.getElementById('reload').title === 'Reload', null, {
    timeout: 60000,
  })
  .catch(() => {});
await page.waitForTimeout(1000);
check(
  'error page: the address bar shows the address that failed',
  (await address()) === 'http://nonexistent.invalid/',
  await address(),
);
await go(selfSignedURL);
const notSecure = await page
  .waitForFunction(
    () =>
      !document.getElementById('security').hidden &&
      document.getElementById('security').textContent === 'Not secure',
    null,
    { timeout: 60000 },
  )
  .then(
    () => true,
    () => false,
  );
check(
  'certificate error page: address bar "Not secure"',
  notSecure,
  JSON.stringify(await security()),
);
await page.click('#back');
const backAgain = await page
  .waitForFunction(
    (url) => document.getElementById('address').value === url,
    'http://nonexistent.invalid/',
    { timeout: 30000 },
  )
  .then(
    () => true,
    () => false,
  );
check('error page: back button to the address before', backAgain, await address());
await page
  .waitForFunction(() => document.getElementById('security').hidden, null, { timeout: 10000 })
  .catch(() => {});
check(
  'error page: address bar without indicator',
  (await security()).hidden,
  JSON.stringify(await security()),
);

selfSigned.close();
await browser.close();
finish();
