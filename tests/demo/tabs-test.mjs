// The tab strip and the toolbar of the demo (the engine side is in tests/core): the speaker in the
// tab appears with sound and mutes the tab on a click, one prompt for camera and microphone, the
// recording indicator follows the camera, the favicon of the page in the tab, its title or address
// after back and forward (also from the back/forward cache), the find bar of each tab that a
// navigation closes, the address bar keeps an address that failed, the security indicator ("Not
// secure" for a certificate error, nothing on other error pages), no network error text in the
// status line next to an error page and the back button. A click on a notification of a service
// worker opens a tab (clients.openWindow) or activates the tab of its page (WindowClient.focus).
// Under memory pressure near a limit like in a 32 bit browser a background tab is discarded, then
// the status line says that memory is full. Ctrl+Shift+T brings the closed tab back. An address
// typed while the engine downloads opens once it runs. An address that loads slowly or asks to
// sign in stays in the address bar and the tab until its page commits, Stop goes back, and so
// does Esc in the page unless the page takes the key.
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
  permissions,
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
  '/plain-a': `<!doctype html><p>A<script>console.log('RESULT ready=plain-a')</script>`,
  '/plain-b': `<!doctype html><p>B<script>console.log('RESULT ready=plain-b')</script>`,
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
  if (req.url === '/slow') {
    const answer = () =>
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Slow</title>');
    return void setTimeout(answer, 4000);
  }
  if (req.url === '/auth')
    return res
      .writeHead(401, { 'Content-Type': 'text/html', 'WWW-Authenticate': 'Basic realm="Tabs"' })
      .end('<title>Denied</title>');
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
  permissions: permissions(['camera', 'microphone']),
});
// Host notifications: headless has none, a stand-in records them so the test can click them.
// Every toDataURL of the host records whether its 2D context reads frequently: a GPU canvas
// waits for the compositor's queued GL work there and blocks the host main thread.
await context.addInitScript(() => {
  const options = new WeakMap();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attributes) {
    if (type === '2d') options.set(this, attributes ?? {});
    return getContext.call(this, type, attributes);
  };
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  window.__blReadbacks = [];
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    window.__blReadbacks.push({ cpu: options.get(this)?.willReadFrequently === true });
    return toDataURL.apply(this, args);
  };
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
      const img = document.querySelector('.tab.active .icon img');
      return img?.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
    },
    null,
    { timeout: 20000 },
  )
  .then(
    (handle) => handle.jsonValue(),
    () => 0,
  );
check('favicon in the tab', icon > 0, `(width ${icon})`);
// The demo remembers the icon of the host for history and bookmarks, read back on the CPU
const remembered = await page
  .waitForFunction(
    (host) => JSON.parse(localStorage.getItem('bl-favicons') ?? '{}')[host]?.icon,
    new URL(siteURL).host,
    { timeout: 10000 },
  )
  .then(
    () => true,
    () => false,
  );
const readbacks = await page.evaluate(() => window.__blReadbacks);
check(
  'favicon remembered with a CPU readback',
  remembered && readbacks.length > 0 && readbacks.every((r) => r.cpu),
  JSON.stringify({ remembered, readbacks }),
);
await screenshot(page, 'demo-tabs');

// 3b) Back and forward: the tab and the window show the page's title, without one its address
const shows = (label) =>
  page
    .waitForFunction(
      (label) =>
        document.getElementById('address').value === label.address &&
        document.querySelector('#tab-list .tab.active .title')?.textContent === label.text &&
        document.title.startsWith(`${label.text} - `),
      label,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    );
const labels = () =>
  page.evaluate(() =>
    JSON.stringify({
      address: document.getElementById('address').value,
      tab: document.querySelector('#tab-list .tab.active .title')?.textContent,
      window: document.title,
    }),
  );
for (const name of ['plain-a', 'plain-b']) {
  results.delete('ready');
  await go(`${siteURL}${name}`);
  await result('ready');
}
await page.click('#back');
check(
  'back between pages without a title: the address',
  await shows({ address: `${siteURL}plain-a`, text: `${siteURL}plain-a` }),
  await labels(),
);
await page.click('#back');
check(
  'back to a page with a title: its title',
  await shows({ address: `${siteURL}icon`, text: 'Icon' }),
  await labels(),
);
await page.click('#forward');
check(
  'forward from a title to a page without one: the address',
  await shows({ address: `${siteURL}plain-a`, text: `${siteURL}plain-a` }),
  await labels(),
);
await page.click('#forward');
check(
  'forward between pages without a title: the address',
  await shows({ address: `${siteURL}plain-b`, text: `${siteURL}plain-b` }),
  await labels(),
);

// 3c) Find bar like Chrome: each tab has its own, a new document (navigation, reload) closes it
const findState = () =>
  page.evaluate(() =>
    JSON.stringify({
      hidden: document.getElementById('find-bar').hidden,
      text: document.getElementById('find-input').value,
      count: document.getElementById('find-count').textContent,
    }),
  );
const findIs = (state) =>
  page
    .waitForFunction(
      (state) =>
        document.getElementById('find-bar').hidden === state.hidden &&
        (state.count === undefined ||
          document.getElementById('find-count').textContent === state.count),
      state,
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
await clickPage();
await page.keyboard.press('Control+f');
// The page gets Ctrl+F first, the bar opens when it does not handle it
await page.waitForFunction(() => document.activeElement?.id === 'find-input', null, {
  timeout: 10000,
});
await page.keyboard.type('B');
check(
  'find: a match on the page',
  await findIs({ hidden: false, count: '1 of 1' }),
  await findState(),
);
await page.keyboard.press('Control+t');
check('find: a new tab has no find bar', await findIs({ hidden: true }), await findState());
await page.keyboard.press('Control+Shift+Tab');
check(
  'find: back in the tab its find bar with text and result',
  (await findIs({ hidden: false, count: '1 of 1' })) && JSON.parse(await findState()).text === 'B',
  await findState(),
);
results.delete('ready');
await page.click('#back');
await result('ready');
check('find: a navigation closes the find bar', await findIs({ hidden: true }), await findState());
await page.keyboard.press('Control+Tab');
await page.keyboard.press('Control+w');
results.delete('ready');
await page.click('#forward');
await result('ready');

// 4) Failing navigations: the address bar keeps the address, the security indicator says
// "Not secure" only for a certificate error, the error page is the only message (no raw
// network layer text in the status line or the phone layout's snackbar)
const address = () => page.inputValue('#address');
await page.evaluate(() => {
  const status = document.getElementById('status');
  window.statusTexts = [];
  new MutationObserver(() => window.statusTexts.push(status.textContent)).observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
});
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
await page.waitForTimeout(1000);
const statusTexts = await page.evaluate(() => window.statusTexts);
check(
  'error pages: no network error text in the status line',
  !statusTexts.some((text) => /error|SSL|resolve/i.test(text)),
  JSON.stringify(statusTexts),
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
// is discarded, then with no loaded background tab left the status line says that the page uses
// the memory, and
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
  'memory pressure with only a discarded background tab: the message names the page',
  /Memory is almost full: this page/.test(await statusText()),
  `${await statusText()} (after ${allocated * 16} MB)`,
);
check(
  'memory pressure: no crash',
  await page.evaluate(() => document.getElementById('boot').hidden && !!window.blTest.view()),
);
await page.evaluate(() => window.blTest.memoryLimit(0));

// 7) Ctrl+Shift+T like Chrome: the tab closed last comes back at its place with back and forward;
// a discarded tab was never closed, with none left nothing happens
const activeIndex = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tab-list .tab')].findIndex((tab) =>
      tab.classList.contains('active'),
    ),
  );
const tabsNow = await tabCount();
await page.keyboard.press('Control+Shift+T');
await page.waitForTimeout(1000);
check(
  'Ctrl+Shift+T with no closed tab: nothing opens',
  (await tabCount()) === tabsNow,
  `${tabsNow} -> ${await tabCount()} tabs`,
);
await page.keyboard.press('Control+t');
results.delete('ready');
await go(`${siteURL}plain-a`);
await result('ready');
results.delete('ready');
await go(`${siteURL}plain-b`);
check('reopen: page loaded', (await result('ready')) === 'plain-b', results.get('ready'));
const closedIndex = await activeIndex();
// Not the last tab: a new tab after it, then back to it and close it
await page.keyboard.press('Control+t');
await page.keyboard.press('Control+Shift+Tab');
await activeIs(`${siteURL}plain-b`);
await page.keyboard.press('Control+w');
await page.waitForFunction(
  (count) => document.querySelectorAll('#tab-list .tab').length === count,
  tabsNow + 1,
);
results.delete('ready');
await page.keyboard.press('Control+Shift+T');
check(
  'Ctrl+Shift+T: the closed tab comes back in front at its place',
  (await activeIs(`${siteURL}plain-b`)) &&
    (await tabCount()) === tabsNow + 2 &&
    (await activeIndex()) === closedIndex,
  `${await activeTitle()}, ${await tabCount()} tabs, at ${await activeIndex()} (was ${closedIndex})`,
);
check('Ctrl+Shift+T: its page loads', (await result('ready')) === 'plain-b', results.get('ready'));
results.delete('ready');
await page.click('#back');
check(
  'Ctrl+Shift+T: back goes to the page before',
  (await result('ready')) === 'plain-a',
  results.get('ready'),
);

// 8) An address that waits (a slow server, a sign in prompt): like Chrome the address bar and the
// tab show it until its page commits, the security indicator of the page being left hides, Stop
// goes back to the address of the page
const addressIs = (url) =>
  page
    .waitForFunction((url) => document.getElementById('address').value === url, url, {
      timeout: 10000,
    })
    .then(
      () => true,
      () => false,
    );
await page.keyboard.press('Control+t');
await go(`${siteURL}slow`);
await page.waitForTimeout(1500);
check(
  'slow address in a new tab: the address bar and the tab show it',
  (await address()) === `${siteURL}slow` && (await activeTitle()) === `${siteURL}slow`,
  `${await address()}, ${await activeTitle()}`,
);
check('slow address: its page follows', await activeIs('Slow'));
await go(`${siteURL}auth`);
const loginPrompt = page.locator('.bl-login-prompt');
check(
  'sign in prompt for an address',
  await loginPrompt.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  ),
);
check(
  'sign in prompt: the address bar keeps the address, no indicator of the page before',
  (await address()) === `${siteURL}auth` && (await security()).hidden,
  `${await address()}, ${JSON.stringify(await security())}`,
);
await loginPrompt.locator('button[data-bl-answer=cancel]').click();
check(
  'sign in cancelled: the 401 page under its address',
  (await activeIs('Denied')) && (await address()) === `${siteURL}auth`,
  `${await activeTitle()}, ${await address()}`,
);
await go(`${siteURL}slow`);
check('slow address again: shown while it loads', await addressIs(`${siteURL}slow`));
await page.waitForTimeout(500);
await page.click('#reload');
const stopped = await addressIs(`${siteURL}auth`);
// Past the server's answer: the stopped address never commits
await page.waitForTimeout(4000);
check(
  'Stop: the address of the page again',
  stopped && (await address()) === `${siteURL}auth` && (await activeTitle()) === 'Denied',
  `${await address()}, ${await activeTitle()}`,
);
// Esc in the page is Stop like in Chrome, but only when the page does not take the key itself
const reloadTitle = () => page.evaluate(() => document.getElementById('reload').title);
await go(`${siteURL}slow`);
await addressIs(`${siteURL}slow`);
await clickPage();
await page.keyboard.press('Escape');
const escStopped = await addressIs(`${siteURL}auth`);
await page.waitForTimeout(4000);
check(
  'Esc in the page stops loading',
  escStopped &&
    (await reloadTitle()) === 'Reload' &&
    (await address()) === `${siteURL}auth` &&
    (await activeTitle()) === 'Denied',
  `${await reloadTitle()}, ${await address()}, ${await activeTitle()}`,
);
// Also with the focus on no field (the address bar takes Esc itself and restores the address)
await go(`${siteURL}slow`);
await addressIs(`${siteURL}slow`);
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('Escape');
const escOutside = await addressIs(`${siteURL}auth`);
check(
  'Esc outside the page and fields stops loading',
  escOutside && (await reloadTitle()) === 'Reload',
  `${await reloadTitle()}, ${await address()}`,
);
await page.evaluate(() =>
  window.blTest.eval(
    `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); })`,
  ),
);
await go(`${siteURL}slow`);
await addressIs(`${siteURL}slow`);
await clickPage();
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);
const escKept = await reloadTitle();
check(
  'Esc the page takes: the page loads on',
  escKept === 'Stop' && (await activeIs('Slow')),
  `${escKept}, ${await activeTitle()}`,
);

// An address typed while the engine still downloads opens as soon as it runs
{
  const early = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await early.route('**/engine.wasm', async (route) => {
    await held;
    await route.continue();
  });
  const earlyPage = await early.newPage();
  await earlyPage.goto(stack.app());
  await earlyPage.fill('#address', `${siteURL}opened`);
  await earlyPage.press('#address', 'Enter');
  const note = await earlyPage.evaluate(() => document.getElementById('boot').textContent);
  check('typed during the download: the start message names it', note.includes('opened'), note);
  release();
  const opened = await earlyPage
    .waitForFunction(
      () => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Opened',
      null,
      { timeout: TIMEOUT },
    )
    .then(
      () => true,
      () => false,
    );
  check('typed during the download: it opens once the engine runs', opened);
  await early.close();
}

selfSigned.close();
await browser.close();
finish();
