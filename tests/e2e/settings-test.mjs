// End-to-End Test der Einstellungen (web/settings.js): die Seite als modaler Dialog (Fokus,
// Tastenkuerzel, Esc), was nur auf diesem Geraet liegt, ein zweiter Tab ohne Profil, was die
// Seiten vom Geraet sehen (Standard wie der Host, dann als iPhone mit eigener Sprache,
// Zeitzone, dunkel und GPC), JavaScript und Bilder aus, Sitzung und Sitzungs-Cookies nach
// "Jetzt neu starten" und nach einem normalen Start ohne "Tabs beim Start wiederherstellen".
//
//   cd tests/e2e && node settings-test.mjs [engine-ordner]
import { TIMEOUT, check, collect, finish, launchProfile, serve, startStack, timeLimit, waitFor } from './harness.mjs';

timeLimit(4 * TIMEOUT);

const html = (body) => `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh">${body}`;
// Was die Seite vom Geraet sieht, dazu die Header der Anfrage
const devicePage = (headers) => `<title>Geraet</title><script>
const info = {
  ua: navigator.userAgent, platform: navigator.platform, languages: navigator.languages.join(','),
  acceptLanguage: ${JSON.stringify(headers['accept-language'] || '')}, gpc: String(navigator.globalPrivacyControl) + '/' + ${JSON.stringify(headers['sec-gpc'] || '')},
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dpr: devicePixelRatio, width: innerWidth, screen: screen.width + 'x' + screen.height,
  touch: navigator.maxTouchPoints, pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : matchMedia('(pointer: fine)').matches ? 'fine' : 'none',
  hover: matchMedia('(hover: hover)').matches ? 'hover' : 'none', dark: matchMedia('(prefers-color-scheme: dark)').matches,
};
console.log('RESULT geraet=' + encodeURIComponent(JSON.stringify(info)));
addEventListener('touchstart', () => console.log('RESULT touch=1'));
</script>`;
let imageRequests = 0;
const PAGES = {
  // Cookie mit Ablauf, Sitzungs-Cookie, grosse IndexedDB
  schreiben: () => `<title>Schreiben</title><script>
const open = indexedDB.open('gross', 1);
open.onupgradeneeded = () => open.result.createObjectStore('w');
open.onsuccess = () => {
  const tx = open.result.transaction('w', 'readwrite');
  tx.objectStore('w').put(new Uint8Array(600000).fill(7), 'x');
  tx.oncomplete = () => console.log('RESULT geschrieben=1');
};
</script>`,
  gross: () => `<title>Gross</title><script>localStorage.setItem('gross', 'x'.repeat(200000)); console.log('RESULT grossgeschrieben=1');</script>`,
  // Ohne JavaScript ist <noscript> Markup und der Titel "JS aus"
  ohnejs: () => `<noscript><title>JS aus</title></noscript><script>document.title = 'JS an';</script><img src="bild.svg">`,
  // Die Cookies, die der Server bekommt, im Titel (geht auch ohne JavaScript)
  cookies: (req) => `<title>Cookies ${(req.headers.cookie || 'keine').replace(/[<&]/g, '')}</title>`,
  geraet: (req) => devicePage(req.headers),
};
const { url: siteA } = await serve((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  if (name === 'bild.svg') {
    imageRequests++;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    return;
  }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (name === 'schreiben')
    headers['Set-Cookie'] = ['dauer=ja; Path=/; Max-Age=86400', 'sitzung=ja; Path=/'];
  res.writeHead(PAGES[name] ? 200 : 404, headers).end(html(PAGES[name]?.(req) || ''));
});
const { url: siteB } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html(PAGES.gross())));

const stack = await startStack({ token: 'settings-token-0123456789abcdef' });
const context = await launchProfile({ locale: 'de-CH', timezoneId: 'Europe/Zurich', viewport: { width: 1100, height: 800 } });
const page = context.pages()[0] || await context.newPage();
page.on('dialog', (dialog) => dialog.accept());
const results = collect(page);

async function go(address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
const booted = (target) => target.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
const titleStarts = (text) => page.waitForFunction((start) => document.title.startsWith(start), text, { timeout: 30000 }).then(() => true, () => false);
const settingsOpen = () => page.evaluate(() => document.getElementById('settings').open);
// Chromium schliesst den Dialog nach Esc erst etwas spaeter
const settingsClosed = () => page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 5000 }).then(() => true, () => false);
const focused = () => page.evaluate(() => {
  const element = document.activeElement;
  return element.id || element.dataset?.section || element.tagName;
});
async function openSettings(section) {
  await page.click('#menu-button');
  await page.locator('#side-panel .panel-menu-item', { hasText: 'Einstellungen' }).click();
  await page.click(`#settings nav button[data-section=${section}]`);
}
async function setText(selector, value) {
  await page.fill(selector, value);
  await page.locator(selector).dispatchEvent('change');
}
async function deviceInfo() {
  results.delete('geraet');
  await go(siteA + 'geraet');
  const value = await results.wait('geraet', 60000);
  return value ? JSON.parse(decodeURIComponent(value)) : {};
}
// "Jetzt neu starten" in den Einstellungen
async function restart() {
  const loaded = page.waitForEvent('load', { timeout: 30000 });
  await page.click('#settings-restart');
  await loaded;
  await booted(page);
}

// 1) Daten: Cookies, grosse IndexedDB, grosses localStorage auf einer zweiten Website
await page.goto(stack.app({ url: siteA + 'schreiben' }));
check('Daten geschrieben', (await results.wait('geschrieben')) === '1');
await go(siteB);
check('Grosses localStorage geschrieben', (await results.wait('grossgeschrieben')) === '1');

// 2) Die Einstellungen sind modal: Fokus darin, Kuerzel des Browsers aus, Esc zurueck zur Seite
await openSettings('general');
check('Einstellungen offen, Fokus darin', await settingsOpen() && await page.evaluate(() => document.getElementById('settings').contains(document.activeElement)), await focused());
const tabCount = () => page.locator('#tab-list .tab').count();
const tabsBefore = await tabCount();
await page.keyboard.press('Control+t');
check('Strg+T hinter den Einstellungen wirkt nicht', (await tabCount()) === tabsBefore);
await page.click('#settings nav button[data-section=device]');
check('Abschnitt wechseln: Fokus bleibt auf dem Knopf', (await focused()) === 'device'
  && (await page.textContent('#settings h2')) === 'Gerät und Browser'
  && (await page.getAttribute('#settings nav button[data-section=device]', 'aria-current')) === 'page');
await page.keyboard.press('Escape');
check('Esc schliesst, Fokus zurueck in der Seite', await settingsClosed() && (await focused()) === 'ime', await focused());

// 3) Profil: was nur auf diesem Geraet liegt (sobald die Engine die Datenbanken geschrieben hat)
await page.click('#clear-data');
const expected = [`127.0.0.1:${new URL(siteA).port}: IndexedDB (über der Grenze)`, `127.0.0.1:${new URL(siteB).port}: localStorage (über der Grenze)`];
let localList = '';
await waitFor(async () => {
  await page.click('#settings nav button[data-section=profile]');
  localList = await page.waitForFunction(() => document.querySelector('#settings .settings-local')?.textContent.includes('Service Worker'), null, { timeout: 10000 })
    .then(() => page.textContent('#settings .settings-local'), () => '');
  return expected.every((text) => localList.includes(text));
}, 30000, 1000);
check('"Nur auf diesem Gerät": grosse IndexedDB und grosses localStorage', expected.every((text) => localList.includes(text)), localList);
await page.keyboard.press('Escape');
await settingsClosed();

// 4) Ein zweiter Tab der Oberflaeche hat kein Profil: Loeschen geht dort nicht
const second = await context.newPage();
second.on('dialog', (dialog) => dialog.accept());
await second.goto(stack.app({ url: 'about:blank' }));
await booted(second);
await second.click('#clear-data');
const secondState = await second.locator('#profile-state').getAttribute('data-state');
check('Zweiter Tab: kein Profil, Loeschen gesperrt', secondState === 'off' && await second.isDisabled('#settings-clear-site-data')
  && await second.isDisabled('#settings-reset-profile'), secondState);
await second.close();

// 5) Standard: wie der Host
const host = await deviceInfo();
check('Standard: Linux-Desktop', host.platform === 'Linux x86_64' && /X11; Linux x86_64/.test(host.ua) && host.dpr === 1 && host.touch === 0
  && host.pointer === 'fine' && host.hover === 'hover' && host.width === 1100, JSON.stringify(host));
check('Standard: Sprache und Zeitzone des Host', host.languages === 'de-CH' && /^de-CH/.test(host.acceptLanguage) && host.timeZone === 'Europe/Zurich', JSON.stringify(host));
check('Standard: hell, ohne GPC', host.dark === false && !host.gpc.startsWith('true'), JSON.stringify(host));
await go(siteA + 'ohnejs');
check('Standard: JavaScript und Bilder an', await titleStarts('JS an') && await (async () => {
  for (let i = 0; i < 50 && !imageRequests; i++)
    await page.waitForTimeout(100);
  return imageRequests > 0;
})(), `${await page.title()}, Bild ${imageRequests}x geladen`);

// 6) Als iPhone mit eigener Sprache und Zeitzone, dunkel, mit GPC
await openSettings('device');
await page.selectOption('#setting-device', 'iphone');
await setText('#setting-languages', 'fr-CH,fr');
await setText('#setting-timezone', 'America/New_York');
await page.selectOption('#setting-color-scheme', 'dark');
await page.check('#setting-gpc');
await restart();
const phone = await deviceInfo();
check('iPhone: User-Agent und platform', /iPhone; CPU iPhone OS/.test(phone.ua) && /Mobile\/\w+ Safari/.test(phone.ua) && phone.platform === 'iPhone', JSON.stringify(phone));
check('iPhone: Bildschirm 390x844, DPR 3, Touch, grober Zeiger ohne Hover', phone.width === 390 && phone.screen === '390x844' && phone.dpr === 3
  && phone.touch > 0 && phone.pointer === 'coarse' && phone.hover === 'none', JSON.stringify(phone));
// navigator.languages hat wie in Safari nur die erste Sprache, Accept-Language alle
check('Eigene Sprache und Zeitzone', phone.languages === 'fr-CH' && phone.acceptLanguage === 'fr-CH, fr' && phone.timeZone === 'America/New_York', JSON.stringify(phone));
check('Dunkel und Global Privacy Control', phone.dark === true && phone.gpc === 'true/1', JSON.stringify(phone));
const box = await page.evaluate(() => {
  const rect = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none').getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width };
});
check('iPhone: Seitenbereich so breit wie das Geraet', Math.round(box.width) === 390, String(box.width));
await page.mouse.click(box.x, box.y);
check('iPhone: die Maus tippt (touchstart)', (await results.wait('touch', 10000)) === '1');

// 7) JavaScript und Bilder aus, Tabs nicht wiederherstellen: "Jetzt neu starten" behaelt die
// Sitzung und die Sitzungs-Cookies trotzdem
await openSettings('device');
await page.uncheck('#setting-javascript');
await page.uncheck('#setting-images');
await page.click('#settings nav button[data-section=general]');
await page.uncheck('#setting-restore');
await page.click('#settings nav button[data-section=device]');
await restart();
const restored = await page.waitForFunction((url) => document.getElementById('address').value === url, siteA + 'geraet', { timeout: 30000 }).then(() => true, () => false);
check('Neustart: Tabs wieder da, auch ohne "Tabs wiederherstellen"', restored, await page.inputValue('#address'));
imageRequests = 0;
await go(siteA + 'ohnejs');
check('JavaScript aus', await titleStarts('JS aus'), await page.title());
await page.waitForTimeout(2000);
check('Bilder aus', imageRequests === 0, `Bild ${imageRequests}x geladen`);
await go(siteA + 'cookies');
check('Neustart: Sitzungs-Cookie bleibt', await titleStarts('Cookies ') && /sitzung=ja/.test(await page.title()) && /dauer=ja/.test(await page.title()), await page.title());

// 8) Normaler Start ohne "Tabs wiederherstellen": das Sitzungs-Cookie ist weg
await page.goto(stack.app({ url: siteA + 'cookies' }));
await booted(page);
check('Normaler Start: Sitzungs-Cookie weg, dauerhaftes bleibt', await titleStarts('Cookies ') && !/sitzung=ja/.test(await page.title()) && /dauer=ja/.test(await page.title()), await page.title());

await context.close();
finish();
