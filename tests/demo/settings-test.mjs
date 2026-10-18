// Settings of the demo (apps/demo/src/settings*.ts): the page as a modal dialog (focus, shortcuts,
// Esc), what lives only on this device, a second tab without the profile, what the pages see of
// the device (default like the host, then as an iPhone with its own language, time zone, dark and
// GPC), JavaScript and images off, session and session cookies after "Restart now" and after a
// normal start without "Restore tabs on start", clearing the site data (cookies, OPFS,
// IndexedDB, localStorage).
//
//   node tests/demo/settings-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launchProfile,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(4 * TIMEOUT);

const html = (body) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh">${body}`;
// What the page sees of the device, plus the headers of the request
const devicePage = (headers) => `<title>Device</title><script>
const info = {
  ua: navigator.userAgent, platform: navigator.platform, languages: navigator.languages.join(','),
  acceptLanguage: ${JSON.stringify(headers['accept-language'] || '')}, gpc: String(navigator.globalPrivacyControl) + '/' + ${JSON.stringify(headers['sec-gpc'] || '')},
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dpr: devicePixelRatio, width: innerWidth, screen: screen.width + 'x' + screen.height,
  touch: navigator.maxTouchPoints, pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : matchMedia('(pointer: fine)').matches ? 'fine' : 'none',
  hover: matchMedia('(hover: hover)').matches ? 'hover' : 'none', dark: matchMedia('(prefers-color-scheme: dark)').matches,
};
console.log('RESULT device=' + encodeURIComponent(JSON.stringify(info)));
addEventListener('touchstart', () => console.log('RESULT touch=1'));
</script>`;
let imageRequests = 0;
const PAGES = {
  // A cookie with expiry, a session cookie, a large IndexedDB, a file in the OPFS
  write: () => `<title>Write</title><script>
const idb = new Promise((resolve) => {
  const open = indexedDB.open('large', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('w');
  open.onsuccess = () => {
    const tx = open.result.transaction('w', 'readwrite');
    tx.objectStore('w').put(new Uint8Array(600000).fill(7), 'x');
    tx.oncomplete = resolve;
  };
});
const opfs = navigator.storage.getDirectory().then(async (root) => {
  const writable = await (await root.getFileHandle('kept.txt', { create: true })).createWritable();
  await writable.write('kept');
  await writable.close();
});
Promise.all([idb, opfs]).then(() => console.log('RESULT written=1'), (e) => console.log('RESULT written=' + e.name));
</script>`,
  // What the site keeps: OPFS file, IndexedDB "large", localStorage "large"
  stored: () => `<title>Stored</title><script>
(async () => {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle('kept.txt').then(async (h) => (await h.getFile()).text(), () => 'none');
  const idb = await new Promise((resolve) => {
    const open = indexedDB.open('large');
    open.onupgradeneeded = () => { open.transaction.abort(); resolve('none'); };
    open.onsuccess = () => { open.result.close(); resolve('large'); };
    open.onerror = () => resolve('none');
  });
  const local = localStorage.getItem('large') ? 'large' : 'none';
  console.log('RESULT stored=' + [file, idb, local].join(','));
})().catch((e) => console.log('RESULT stored=error:' + e.name));
</script>`,
  large: () =>
    `<title>Large</title><script>localStorage.setItem('large', 'x'.repeat(200000)); console.log('RESULT largewritten=1');</script>`,
  // Without JavaScript <noscript> is markup and the title is "JS off"
  nojs: () =>
    `<noscript><title>JS off</title></noscript><script>document.title = 'JS on';</script><img src="image.svg">`,
  // The cookies the server gets, in the title (also works without JavaScript)
  cookies: (req) => `<title>Cookies ${(req.headers.cookie || 'none').replace(/[<&]/g, '')}</title>`,
  device: (req) => devicePage(req.headers),
};
const { url: siteA } = await serve((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  if (name === 'image.svg') {
    imageRequests++;
    res
      .writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
      .end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    return;
  }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (name === 'write')
    headers['Set-Cookie'] = ['lasting=yes; Path=/; Max-Age=86400', 'session=yes; Path=/'];
  res.writeHead(PAGES[name] ? 200 : 404, headers).end(html(PAGES[name]?.(req) || ''));
});
const { url: siteB } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(html(req.url === '/stored' ? PAGES.stored() : PAGES.large())),
);

const stack = await startStack({ app: 'demo', token: 'settings-token-0123456789abcdef' });
const context = await launchProfile({
  locale: 'de-CH',
  timezoneId: 'Europe/Zurich',
  viewport: { width: 1100, height: 800 },
});
const page = context.pages()[0] || (await context.newPage());
page.on('dialog', (dialog) => dialog.accept());
const results = collect(page);

async function go(address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
const booted = (target) =>
  target.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const titleStarts = (text) =>
  page
    .waitForFunction((start) => document.title.startsWith(start), text, { timeout: 30000 })
    .then(
      () => true,
      () => false,
    );
const settingsOpen = () => page.evaluate(() => document.getElementById('settings').open);
// Chromium closes the dialog a little after Esc
const settingsClosed = () =>
  page
    .waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
const focused = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    return (
      element.id ||
      element.dataset?.section ||
      (element.hasAttribute('data-bl-ime') ? 'page' : element.tagName)
    );
  });
async function openSettings(section) {
  await page.click('#menu-button');
  await page.locator('#side-panel .panel-menu-item', { hasText: 'Settings' }).click();
  await page.click(`#settings nav button[data-section=${section}]`);
}
async function setText(selector, value) {
  await page.fill(selector, value);
  await page.locator(selector).dispatchEvent('change');
}
async function deviceInfo() {
  results.delete('device');
  await go(siteA + 'device');
  const value = await results.wait('device', 60000);
  return value ? JSON.parse(decodeURIComponent(value)) : {};
}
// "Restart now" in the settings
async function restart() {
  const loaded = page.waitForEvent('load', { timeout: 30000 });
  await page.click('#settings-restart');
  await loaded;
  await booted(page);
}

// 1) Data: cookies, a large IndexedDB, a large localStorage on a second site
await page.goto(stack.app({ url: siteA + 'write' }));
check('data written', (await results.wait('written')) === '1');
await go(siteB);
check('large localStorage written', (await results.wait('largewritten')) === '1');

// 2) The settings are modal: focus inside, browser shortcuts off, Esc back to the page
await openSettings('general');
check(
  'settings open, focus inside',
  (await settingsOpen()) &&
    (await page.evaluate(() =>
      document.getElementById('settings').contains(document.activeElement),
    )),
  await focused(),
);
const tabCount = () => page.locator('#tab-list .tab').count();
const tabsBefore = await tabCount();
await page.keyboard.press('Control+t');
check('Ctrl+T behind the settings does nothing', (await tabCount()) === tabsBefore);
await page.click('#settings nav button[data-section=device]');
check(
  'switch section: the focus stays on the button',
  (await focused()) === 'device' &&
    (await page.textContent('#settings h2')) === 'Device and browser' &&
    (await page.getAttribute('#settings nav button[data-section=device]', 'aria-current')) ===
      'page',
);
await page.keyboard.press('Escape');
check(
  'Esc closes, focus back in the page',
  (await settingsClosed()) && (await focused()) === 'page',
  await focused(),
);

// 3) Profile: what lives only on this device (as soon as the engine wrote the databases)
await page.click('#clear-data');
const expected = [
  `127.0.0.1:${new URL(siteA).port}: IndexedDB (over the limit)`,
  `127.0.0.1:${new URL(siteB).port}: localStorage (over the limit)`,
];
let localList = '';
await waitFor(
  async () => {
    await page.click('#settings nav button[data-section=profile]');
    localList = await page
      .waitForFunction(
        () =>
          document
            .querySelector('#settings .settings-local')
            ?.textContent.includes('Service workers'),
        null,
        { timeout: 10000 },
      )
      .then(
        () => page.textContent('#settings .settings-local'),
        () => '',
      );
    return expected.every((text) => localList.includes(text));
  },
  30000,
  1000,
);
check(
  '"Only on this device": large IndexedDB and large localStorage',
  expected.every((text) => localList.includes(text)),
  localList,
);
await page.keyboard.press('Escape');
await settingsClosed();

// 4) A second tab of the demo has no profile: deleting does not work there
const second = await context.newPage();
second.on('dialog', (dialog) => dialog.accept());
await second.goto(stack.app({ url: 'about:blank' }));
await booted(second);
await second.click('#clear-data');
const secondState = await second.locator('#profile-state').getAttribute('data-state');
check(
  'second tab: no profile, deleting blocked',
  secondState === 'off' &&
    (await second.isDisabled('#settings-clear-site-data')) &&
    (await second.isDisabled('#settings-reset-profile')),
  secondState,
);
await second.close();

// 5) Default: like the host
const host = await deviceInfo();
check(
  'default: Linux desktop',
  host.platform === 'Linux x86_64' &&
    /X11; Linux x86_64/.test(host.ua) &&
    host.dpr === 1 &&
    host.touch === 0 &&
    host.pointer === 'fine' &&
    host.hover === 'hover' &&
    host.width === 1100,
  JSON.stringify(host),
);
check(
  'default: language and time zone of the host',
  host.languages === 'de-CH' &&
    /^de-CH/.test(host.acceptLanguage) &&
    host.timeZone === 'Europe/Zurich',
  JSON.stringify(host),
);
check(
  'default: light, without GPC',
  host.dark === false && !host.gpc.startsWith('true'),
  JSON.stringify(host),
);
await go(siteA + 'nojs');
check(
  'default: JavaScript and images on',
  (await titleStarts('JS on')) &&
    (await (async () => {
      for (let i = 0; i < 50 && !imageRequests; i++) await page.waitForTimeout(100);
      return imageRequests > 0;
    })()),
  `${await page.title()}, image loaded ${imageRequests}x`,
);

// 6) As an iPhone with its own language and time zone, dark, with GPC
await openSettings('device');
await page.selectOption('#setting-device', 'iphone');
await setText('#setting-languages', 'fr-CH,fr');
await setText('#setting-timezone', 'America/New_York');
await page.selectOption('#setting-color-scheme', 'dark');
await page.check('#setting-gpc');
await restart();
const phone = await deviceInfo();
check(
  'iPhone: user agent and platform',
  /iPhone; CPU iPhone OS/.test(phone.ua) &&
    /Mobile\/\w+ Safari/.test(phone.ua) &&
    phone.platform === 'iPhone',
  JSON.stringify(phone),
);
check(
  'iPhone: screen 390x844, DPR 3, touch, coarse pointer without hover',
  phone.width === 390 &&
    phone.screen === '390x844' &&
    phone.dpr === 3 &&
    phone.touch > 0 &&
    phone.pointer === 'coarse' &&
    phone.hover === 'none',
  JSON.stringify(phone),
);
// navigator.languages has only the first language like in Safari, Accept-Language all
check(
  'own language and time zone',
  phone.languages === 'fr-CH' &&
    phone.acceptLanguage === 'fr-CH, fr' &&
    phone.timeZone === 'America/New_York',
  JSON.stringify(phone),
);
check(
  'dark and Global Privacy Control',
  phone.dark === true && phone.gpc === 'true/1',
  JSON.stringify(phone),
);
const box = await page.evaluate(() => {
  const rect = [...document.querySelectorAll('canvas[data-bl-view]')]
    .find((c) => c.style.display !== 'none')
    .getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width };
});
check('iPhone: page area as wide as the device', Math.round(box.width) === 390, String(box.width));
await page.mouse.click(box.x, box.y);
check('iPhone: the mouse taps (touchstart)', (await results.wait('touch', 10000)) === '1');

// 7) JavaScript and images off, do not restore tabs: "Restart now" still keeps the session and
// the session cookies
await openSettings('device');
await page.uncheck('#setting-javascript');
await page.uncheck('#setting-images');
await page.click('#settings nav button[data-section=general]');
await page.uncheck('#setting-restore');
await page.click('#settings nav button[data-section=device]');
await restart();
const restored = await page
  .waitForFunction((url) => document.getElementById('address').value === url, siteA + 'device', {
    timeout: 30000,
  })
  .then(
    () => true,
    () => false,
  );
check(
  'restart: tabs back, even without "Restore tabs"',
  restored,
  await page.inputValue('#address'),
);
imageRequests = 0;
await go(siteA + 'nojs');
check('JavaScript off', await titleStarts('JS off'), await page.title());
await page.waitForTimeout(2000);
check('images off', imageRequests === 0, `image loaded ${imageRequests}x`);
await go(siteA + 'cookies');
check(
  'restart: the session cookie stays',
  (await titleStarts('Cookies ')) &&
    /session=yes/.test(await page.title()) &&
    /lasting=yes/.test(await page.title()),
  await page.title(),
);

// 8) A normal start without "Restore tabs": the session cookie is gone
await page.goto(stack.app({ url: siteA + 'cookies' }));
await booted(page);
check(
  'normal start: the session cookie is gone, the lasting one stays',
  (await titleStarts('Cookies ')) &&
    !/session=yes/.test(await page.title()) &&
    /lasting=yes/.test(await page.title()),
  await page.title(),
);

// 9) "Clear site data" in the settings: the demo reloads and empties /data before the engine
// starts, the OPFS file, the databases and the lasting cookie are gone. JavaScript on again for
// the pages that read the storage
async function stored(site) {
  results.delete('stored');
  await go(`${site}stored`);
  return results.wait('stored', 30000);
}
await openSettings('device');
await page.check('#setting-javascript');
await restart();
const keptA = await stored(siteA);
const keptB = await stored(siteB);
check(
  'before clearing: OPFS file, IndexedDB and localStorage kept',
  keptA === 'kept,large,none' && keptB === 'none,none,large',
  `${keptA} / ${keptB}`,
);
await page.click('#clear-data');
const clearReload = page.waitForEvent('load', { timeout: 30000 }).then(
  () => true,
  () => false,
);
await page.click('#settings-clear-site-data');
check('clear site data reloads the demo', await clearReload);
await booted(page);
await go(siteA + 'cookies');
check(
  'clear site data: no cookies afterwards',
  await titleStarts('Cookies none'),
  await page.title(),
);
const clearedA = await stored(siteA);
const clearedB = await stored(siteB);
check(
  'clear site data: OPFS file, IndexedDB and localStorage gone',
  clearedA === 'none,none,none' && clearedB === 'none,none,none',
  `${clearedA} / ${clearedB}`,
);

await context.close();
finish();
