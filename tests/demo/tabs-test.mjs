// The tab strip and the toolbar of the demo (the engine side is in tests/core): the speaker in the
// tab appears with sound and mutes the tab on a click, one prompt for camera and microphone, the
// recording indicator follows the camera, the favicon of the page in the tab, the address bar
// keeps an address that failed, the security indicator ("Not secure" for a certificate error,
// nothing on other error pages) and the back button. A click on a notification of a service
// worker opens a tab (clients.openWindow) or activates the tab of its page (WindowClient.focus).
// Under memory pressure near a limit like in a 32 bit browser a background tab is discarded, then
// the status line says that memory is full.
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
  stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  console.log('RESULT camera=on');
});
console.log('RESULT ready=camera');
</script>`,
  '/icon': `<!doctype html><title>Icon</title><link rel="icon" href="/icon.svg"><p>Icon<script>console.log('RESULT ready=icon')</script>`,
  // Controlled by /sw.js; a click allows notifications and shows two
  '/notify': `<!doctype html><title>Notification</title><body style="margin:0;height:100vh">Notification<script>
const log = (text) => console.log('RESULT ' + text);
navigator.serviceWorker.addEventListener('message', (e) => log('focus=' + e.data));
navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
  if (navigator.serviceWorker.controller) log('ready=notify');
  else navigator.serviceWorker.addEventListener('controllerchange', () => log('ready=notify'));
});
document.addEventListener('click', async () => {
  log('notifypermission=' + await Notification.requestPermission());
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Open', { tag: 'open' });
  await reg.showNotification('Focus', { tag: 'focus' });
});
</script>`,
  '/opened': `<!doctype html><title>Opened</title><p>Opened`,
};
const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.notification.tag === 'open') return e.waitUntil(self.clients.openWindow('/opened'));
  e.waitUntil(self.clients.matchAll().then((clients) => clients.find((c) => new URL(c.url).pathname === '/notify').focus())
    .then((client) => client.postMessage(new URL(client.url).pathname)));
});`;
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/icon.svg')
    return res
      .writeHead(200, { 'Content-Type': 'image/svg+xml' })
      .end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0a0"/></svg>',
      );
  if (req.url === '/sw.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SW);
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
// Host notifications: headless has none, a stand-in records them so the test can click them
await context.addInitScript(() => {
  window.__blNotifications = [];
  window.Notification = class extends EventTarget {
    static permission = 'granted';
    static requestPermission() {
      return Promise.resolve('granted');
    }
    constructor(title, options = {}) {
      super();
      Object.assign(this, options, { title });
      window.__blNotifications.push(this);
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
  };
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

// 2) One prompt for camera and microphone, the recording indicator in the tab while they run
results.delete('ready');
await go(`${siteURL}camera`);
await result('ready');
await clickPage();
const prompt = page.locator('.bl-permission-prompt:not([hidden])');
const promptShown = (timeout) =>
  prompt.waitFor({ timeout }).then(
    () => true,
    () => false,
  );
const cameraPrompt = await promptShown(15000);
const cameraText = cameraPrompt ? await prompt.textContent() : '';
check('one prompt for camera and microphone', /camera and microphone/.test(cameraText), cameraText);
if (cameraPrompt) await prompt.locator('button', { hasText: 'Allow' }).click();
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

// 5) A click on a notification of a service worker: clients.openWindow opens a tab in front,
// WindowClient.focus activates the tab of the page again
const tabCount = () => page.locator('#tab-list .tab').count();
const activeTitle = () =>
  page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent);
const activeIs = (title) =>
  page
    .waitForFunction(
      (title) => document.querySelector('#tab-list .tab.active .title')?.textContent === title,
      title,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    );
results.delete('ready');
await go(`${siteURL}notify`);
check(
  'notification page controlled by its service worker',
  (await result('ready')) === 'notify',
  results.get('ready'),
);
await clickPage();
if (await promptShown(10000)) await prompt.locator('button', { hasText: 'Allow' }).click();
check(
  'notifications allowed',
  (await result('notifypermission', 15000)) === 'granted',
  results.get('notifypermission'),
);
const shown = await page
  .waitForFunction(() => window.__blNotifications.some((n) => n.title === 'Focus'), null, {
    timeout: 15000,
  })
  .then(
    () => true,
    () => false,
  );
check('notifications shown in the host', shown);
const tabsBefore = await tabCount();
await page.evaluate(() =>
  window.__blNotifications.find((n) => n.title === 'Open').dispatchEvent(new Event('click')),
);
check(
  'notificationclick: clients.openWindow opens a tab in front',
  (await activeIs('Opened')) && (await tabCount()) === tabsBefore + 1,
  `${await activeTitle()}, ${tabsBefore} -> ${await tabCount()} tabs`,
);
await page.evaluate(() =>
  window.__blNotifications.find((n) => n.title === 'Focus').dispatchEvent(new Event('click')),
);
const focused = await result('focus');
check(
  'notificationclick: WindowClient.focus activates the tab of the page',
  focused === '/notify' && (await activeIs('Notification')),
  `${focused}, ${await activeTitle()}`,
);

// 6) Memory pressure with a limit like a 32 bit browser (debug memoryLimit): the background tab
// is discarded, then with no background tab left the status line says that memory is full, and
// the engine does not crash
const viewIds = () => page.evaluate(() => window.blTest.views().map((view) => view.id));
const idsBefore = await viewIds();
const memoryMB = Math.round((await page.evaluate(() => window.blTest.memory())) / 2 ** 20);
// At least the smallest limit measured in i386 Chromium, malloc fails there
await page.evaluate((mb) => window.blTest.memoryLimit(mb), Math.max(640, memoryMB + 256));
let allocated = 0;
const allocate = async () => {
  allocated++;
  await page.evaluate(() =>
    window.blTest.eval(
      '(window.big ||= []).push(new Uint8Array(16 << 20).fill(1)); console.log("RESULT allocated=" + big.length)',
    ),
  );
  for (let i = 0; i < 100 && results.get('allocated') !== String(allocated); i++)
    await page.waitForTimeout(100);
};
const statusText = () => page.evaluate(() => document.getElementById('status').textContent);
let discarded = false;
for (let i = 0; i < 60 && !/Memory is almost full/.test(await statusText()); i++) {
  await allocate();
  const ids = await viewIds();
  discarded ||= ids.length === idsBefore.length && ids.some((id) => !idsBefore.includes(id));
}
check(
  'memory pressure: the background tab is discarded',
  discarded,
  `${JSON.stringify(idsBefore)} -> ${JSON.stringify(await viewIds())}`,
);
check(
  'memory pressure: the active tab stays',
  (await activeTitle()) === 'Notification' && (await tabCount()) === idsBefore.length,
  `${await activeTitle()}, ${await tabCount()} tabs`,
);
check(
  'memory pressure without a background tab: message in the status line',
  /Memory is almost full/.test(await statusText()),
  `${await statusText()} (after ${allocated * 16} MB)`,
);
check(
  'memory pressure: no crash',
  await page.evaluate(() => document.getElementById('boot').hidden && !!window.blTest.view()),
);
await page.evaluate(() => window.blTest.memoryLimit(0));

selfSigned.close();
await browser.close();
finish();
