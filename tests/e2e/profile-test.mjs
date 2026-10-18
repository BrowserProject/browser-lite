// End-to-End Test fuer das Profil auf dem Server (packages/profile, packages/server/src/profile.ts): angemeldet
// bleiben auf einem zweiten Geraet (neues Chromium-Profil am selben Server) mit Cookie,
// Sitzungs-Cookie, localStorage und kleiner IndexedDB; grosse Datenbanken bleiben auf dem
// Geraet, eine ueber die Grenze gewachsene faellt aus dem Profil; lokal geloescht ist auch auf
// dem Server weg; Uebernahme und Zuruecksetzen durch das andere Geraet; Einstellungen und
// Lesezeichen im Profil; was vor dem Schliessen nicht mehr hochging, kommt beim naechsten
// Start nach und wird nicht vom Server ueberschrieben; Profil zuruecksetzen; ohne Server
// bleibt alles lokal und geht beim naechsten Start mit Server hoch. Die Einstellungsseite
// selber: settings-test.mjs.
//
//   cd tests/e2e && node profile-test.mjs [engine-ordner]
import fs from 'node:fs';
import path from 'node:path';
import { TIMEOUT, check, collect, finish, launchProfile, serve, startStack, timeLimit, waitFor } from './harness.mjs';

timeLimit(6 * TIMEOUT);

const html = (body) => `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh">${body}`;
const SITE_A = {
  // Cookie mit Ablauf, Sitzungs-Cookie, localStorage, kleine und grosse IndexedDB
  schreiben: `<title>Schreiben</title><script>
(async () => {
  localStorage.setItem('login', 'ja');
  const put = (name, value) => new Promise((resolve) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('w');
    open.onsuccess = () => {
      const tx = open.result.transaction('w', 'readwrite');
      tx.objectStore('w').put(value, 'x');
      tx.oncomplete = tx.onerror = () => { open.result.close(); resolve(); };
    };
    open.onerror = resolve;
  });
  await put('klein', 'wert');
  await put('gross', new Uint8Array(600000).fill(7));
  console.log('RESULT geschrieben=1');
})();
</script>`,
  // IndexedDB "wachsend" mit ?n Bytes
  wachsen: `<title>Wachsen</title><script>
const open = indexedDB.open('wachsend', 1);
open.onupgradeneeded = () => open.result.createObjectStore('w');
open.onsuccess = () => {
  const size = Number(new URLSearchParams(location.search).get('n'));
  const tx = open.result.transaction('w', 'readwrite');
  tx.objectStore('w').put(new Uint8Array(size).fill(1), 'x');
  tx.oncomplete = () => { open.result.close(); console.log('RESULT gewachsen=' + size); };
};
</script>`,
  lesen: `<title>Lesen</title><script>
(async () => {
  const cookie = (name) => (document.cookie.match(new RegExp('(^|; )' + name + '=(\\\\w+)')) || [])[2] || 'nein';
  const names = (await indexedDB.databases()).map((db) => db.name);
  const get = (name) => !names.includes(name) ? 'keine' : new Promise((resolve) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => {
      const request = open.result.transaction('w').objectStore('w').get('x');
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result == null ? 'leer' : typeof request.result === 'string' ? request.result : String(request.result.length));
      };
      request.onerror = () => resolve('fehler');
    };
    open.onerror = () => resolve('fehler');
  });
  console.log('RESULT lesen=' + [...['dauer', 'sitzung', 'nach', 'spaet', 'offen'].map((name) => name + ':' + cookie(name)),
    'local:' + (localStorage.getItem('login') || 'leer'), 'klein:' + await get('klein'), 'gross:' + await get('gross')].join(','));
})();
</script>`,
  loeschen: `<title>Loeschen</title><script>
const request = indexedDB.deleteDatabase('klein');
request.onsuccess = request.onerror = () => console.log('RESULT geloescht=1');
</script>`,
};
const SITE_B = {
  gross: `<title>Gross</title><script>localStorage.setItem('gross', 'x'.repeat(200000)); console.log('RESULT grossgeschrieben=1');</script>`,
  lesen: `<title>Gross lesen</title><script>console.log('RESULT grosslesen=' + (localStorage.getItem('gross') || '').length);</script>`,
};

const site = (pages) => serve((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (name === 'schreiben')
    headers['Set-Cookie'] = ['dauer=ja; Path=/; Max-Age=86400', 'sitzung=ja; Path=/'];
  res.writeHead(pages[name] ? 200 : 404, headers).end(html(pages[name] || ''));
});
const { url: siteA } = await site(SITE_A);
const { url: siteB } = await site(SITE_B);
// Ursprung im OPFS bzw. Profil, wie WebKit ihn schreibt
const originA = `http_127.0.0.1_${new URL(siteA).port}`;
const originB = `http_127.0.0.1_${new URL(siteB).port}`;

const stack = await startStack({ token: 'profile-token-0123456789abcdef' });
const info = async () => (await fetch(stack.uiURL + 'profile/info')).json();
const paths = (profile) => profile.files.map((file) => file.path);
const databases = (profile, origin) => [...new Set(paths(profile).filter((p) => p.startsWith(`indexeddb/v1/${origin}/`)).map((p) => path.posix.dirname(p)))];
// Cookies von 127.0.0.1 in cookies.db auf dem Server (node:sqlite)
const serverCookies = async () => (await info()).cookies?.find((c) => c.domain === '127.0.0.1')?.count || 0;
const serverPrefs = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stack.profileDir, 'prefs', name + '.json'), 'utf8'));
  } catch {
    return null;
  }
};

// Ein Geraet: eigenes Chromium-Profil, Sprache und Zeitzone des Host fest
async function device() {
  const context = await launchProfile({ locale: 'de-CH', timezoneId: 'Europe/Zurich', viewport: { width: 1100, height: 800 } });
  const page = context.pages()[0] || await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  return { context, page, results: collect(page) };
}
async function go(page, address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
const booted = (page) => page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
// Oberflaeche neu mit ?url=siteA/lesen, gibt was die Seite liest
async function reopen(dev) {
  dev.results.clear();
  await dev.page.goto(stack.app({ url: siteA + 'lesen' }));
  return lesen(await dev.results.wait('lesen'));
}
// Dateien im OPFS eines Geraets unter dir (Fehlersuche)
const opfsFiles = (page, dir) => page.evaluate(async (name) => {
  const files = [];
  const walk = async (handle, prefix) => {
    for await (const [entry, child] of handle.entries()) {
      if (child.kind === 'directory')
        await walk(child, prefix + entry + '/');
      else
        files.push(prefix + entry + ':' + (await child.getFile()).size);
    }
  };
  await walk(await (await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')).getDirectoryHandle(name), name + '/');
  return files;
}, dir).catch((error) => [String(error)]);
const lesen = (text) => Object.fromEntries((text || '').split(',').map((pair) => pair.split(':')));
const profileStatus = (page) => page.evaluate(() => window.blTest.profile.status);
const searchEngine = (page) => page.evaluate(() => window.blTest.settings().searchEngine);
// Device 1 uploads what changed right after its start; before another device takes over, that
// upload must be done (else it gets 'taken' instead of the later 'reset'): the server stays
// unchanged for 3 s
async function serverSettled() {
  let last = '';
  let since = Date.now();
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    const state = JSON.stringify((await info()).files);
    if (state !== last) {
      last = state;
      since = Date.now();
    } else if (Date.now() - since >= 3000) {
      return true;
    }
  }
  return false;
}
const setCookie = (page, cookie) => page.evaluate((text) => window.blTest.eval(`document.cookie = ${JSON.stringify(text)}`), cookie);
// Uploads ins Profil scheitern (Netz weg), open geht
const blockUploads = (context) => context.route('**/profile/files/**', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
const unblockUploads = (context) => context.unroute('**/profile/files/**');
async function openSettings(page, section) {
  await page.click('#menu-button');
  await page.locator('#side-panel .panel-menu-item', { hasText: 'Settings' }).click();
  await page.click(`#settings nav button[data-section=${section}]`);
}

// 1) Geraet 1 schreibt, der Abgleich bringt nur die kleinen Datenbanken auf den Server
const one = await device();
await one.page.goto(stack.app({ url: siteA + 'schreiben' }));
check('Geraet 1: Daten geschrieben', (await one.results.wait('geschrieben')) === '1');
await go(one.page, siteB + 'gross');
check('Geraet 1: grosses localStorage geschrieben', (await one.results.wait('grossgeschrieben')) === '1');
let profile = null;
const synced = await waitFor(async () => {
  profile = await info();
  const cookies = profile.cookies?.find((c) => c.domain === '127.0.0.1');
  return paths(profile).includes('cookies.db') && paths(profile).includes(`localstorage/${originA}.localstorage`)
    && databases(profile, originA).length === 1 && (!profile.cookies || cookies?.count === 2);
}, 60000, 1000);
check('Server: cookies.db, kleines localStorage und kleine IndexedDB im Profil', synced, JSON.stringify(paths(profile)));
if (profile.cookies)
  check('Server: zwei Cookies, eines fuer die Sitzung', JSON.stringify(profile.cookies) === JSON.stringify([{ domain: '127.0.0.1', count: 2, session: 1 }]), JSON.stringify(profile.cookies));
const localBig = await one.page.evaluate(async (name) => {
  const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')).getDirectoryHandle('localstorage');
  return (await (await dir.getFileHandle(name)).getFile()).size;
}, `${originB}.localstorage`).catch(() => 0);
check('Server: grosse IndexedDB und grosses localStorage nicht im Profil, bleiben auf Geraet 1',
  databases(profile, originA).length === 1 && !paths(profile).includes(`localstorage/${originB}.localstorage`) && localBig > 256 * 1024,
  `${JSON.stringify(paths(profile))}, lokal ${localBig} B`);
await go(one.page, siteA + 'wachsen?n=10');
await one.results.wait('gewachsen');
check('Neue kleine IndexedDB im Profil', await waitFor(async () => databases(profile = await info(), originA).length === 2, 30000, 500), JSON.stringify(paths(profile)));
one.results.delete('gewachsen');
await go(one.page, siteA + 'wachsen?n=400000');
await one.results.wait('gewachsen');
check('Ueber die Grenze gewachsen: auf dem Server weg', await waitFor(async () => databases(profile = await info(), originA).length === 1, 30000, 500), JSON.stringify(paths(profile)));

// 2) Geraet 2 (neues Chromium-Profil): angemeldet wie auf Geraet 1
const two = await device();
await two.page.goto(stack.app({ url: siteA + 'lesen' }));
const onTwo = lesen(await two.results.wait('lesen'));
check('Geraet 2: Cookie, localStorage und kleine IndexedDB da', onTwo.dauer === 'ja' && onTwo.local === 'ja' && onTwo.klein === 'wert', JSON.stringify(onTwo));
check('Geraet 2: Sitzungs-Cookie da', onTwo.sitzung === 'ja', JSON.stringify(onTwo));
check('Geraet 2: grosse IndexedDB nicht uebertragen', onTwo.gross === 'keine', JSON.stringify(onTwo));
await go(two.page, siteB + 'lesen');
check('Geraet 2: grosses localStorage nicht uebertragen', (await two.results.wait('grosslesen')) === '0', two.results.get('grosslesen'));

// 3) Geraet 1 merkt die Uebernahme beim naechsten Schreiben und hoert auf
await setCookie(one.page, 'nach=ja; Path=/; Max-Age=3600');
const notice = await one.page.waitForSelector('#profile-notice:not([hidden])', { timeout: 30000 }).then((element) => element.textContent(), () => '');
check('Geraet 1: Hinweis "opened on another device" mit Reload', notice.includes('opened on another device') && notice.includes('Reload'), notice);
check('Geraet 1: Abgleich gestoppt', (await profileStatus(one.page)) === 'taken');

// 4) Geraet 2 loescht eine Datenbank, aendert Einstellungen und setzt ein Lesezeichen
await go(two.page, siteA + 'loeschen');
check('Geraet 2: Datenbank geloescht', (await two.results.wait('geloescht')) === '1');
const deleted = await waitFor(async () => databases(profile = await info(), originA).length === 0, 60000, 1000);
check('Lokal geloeschte Datenbank auch auf dem Server weg', deleted, JSON.stringify(paths(profile)) + ' lokal ' + JSON.stringify(await opfsFiles(two.page, 'indexeddb')));
await openSettings(two.page, 'general');
await two.page.selectOption('#setting-search', 'google');
await two.page.keyboard.press('Escape');
await two.page.click('#bookmark');
check('Einstellungen und Lesezeichen auf dem Server', await waitFor(() => serverPrefs('settings')?.searchEngine === 'google' && serverPrefs('bookmarks')?.length === 1, 10000),
  JSON.stringify([serverPrefs('settings'), serverPrefs('bookmarks')]));

// 5) Geraet 1 neu geladen: uebernimmt wieder, der Server gilt (nicht hochgeladenes Cookie weg,
// geloeschte Datenbank weg), grosse Datenbanken bleiben als Cache, Einstellungen von Geraet 2
const onOne = await reopen(one);
check('Geraet 1 wieder: Stand des Servers', onOne.dauer === 'ja' && onOne.sitzung === 'ja' && onOne.nach === 'nein' && onOne.local === 'ja' && onOne.klein === 'keine', JSON.stringify(onOne));
check('Geraet 1 wieder: grosse IndexedDB noch da', onOne.gross === '600000', JSON.stringify(onOne));
await go(one.page, siteB + 'lesen');
check('Geraet 1 wieder: grosses localStorage noch da', (await one.results.wait('grosslesen')) === '200000', one.results.get('grosslesen'));
check('Geraet 1 wieder: Suchmaschine und Lesezeichen von Geraet 2',
  (await searchEngine(one.page)) === 'google' && (await one.page.evaluate(() => window.blTest.profile.prefs('bookmarks')?.length)) === 1);
check('Geraet 1 wieder: kein Hinweis', await one.page.evaluate(() => document.getElementById('profile-notice').hidden));

// 6) Geraet 2 uebernimmt und loescht die Websitedaten: Geraet 1 bekommt "zurueckgesetzt",
// Einstellungen und Lesezeichen bleiben im Profil
check('Geraet 1 wieder: Abgleich fertig', await serverSettled());
const idBefore = (await info()).id;
two.results.clear();
await two.page.goto(stack.app({ url: siteA + 'lesen' }));
await two.results.wait('lesen');
await two.page.click('#clear-data');
const twoReloaded = two.page.waitForEvent('load', { timeout: 30000 }).then(() => true, () => false);
await two.page.click('#settings-clear-site-data');
check('Geraet 2: Websitedaten loeschen laedt neu', await twoReloaded);
profile = await info();
check('Server: Websitedaten weg, Einstellungen und Lesezeichen bleiben', profile.id !== idBefore && profile.files.length === 0
  && serverPrefs('settings')?.searchEngine === 'google' && serverPrefs('bookmarks')?.length === 1, JSON.stringify(paths(profile)));
await setCookie(one.page, 'nach=ja; Path=/; Max-Age=3600');
const resetNotice = await one.page.waitForSelector('#profile-notice:not([hidden])', { timeout: 30000 }).then((element) => element.textContent(), () => '');
check('Geraet 1: Hinweis "was reset"', resetNotice.includes('was reset') && (await profileStatus(one.page)) === 'reset', resetNotice);
await booted(two.page);
await two.context.close();

// 7) Was kurz vor dem Schliessen geaendert und nicht mehr hochgeladen wurde, kommt beim
// naechsten Start desselben Geraets auf den Server
const fresh = await reopen(one);
check('Geraet 1 nach dem Loeschen auf Geraet 2: abgemeldet', fresh.dauer === 'nein' && fresh.local === 'leer', JSON.stringify(fresh));
one.results.clear();
await go(one.page, siteA + 'schreiben');
await one.results.wait('geschrieben');
check('Geraet 1: zwei Cookies auf dem Server', await waitFor(async () => (await serverCookies()) === 2, 30000, 500), String(await serverCookies()));
await blockUploads(one.context);
await setCookie(one.page, 'spaet=ja; Path=/; Max-Age=3600');
await one.page.waitForTimeout(4000);
check('Hochladen gesperrt: Cookie nicht auf dem Server', (await serverCookies()) === 2, String(await serverCookies()));
await one.page.goto('about:blank');
await unblockUploads(one.context);
const late = await reopen(one);
check('Naechster Start: Cookie von vor dem Schliessen da und auf dem Server', late.spaet === 'ja' && await waitFor(async () => (await serverCookies()) === 3, 10000, 250),
  `${JSON.stringify(late)} Server ${await serverCookies()}`);

// 8) Scheitert das Nachholen beim Start, ueberschreibt der Server die Aenderung nicht, sie geht
// spaeter hoch
await blockUploads(one.context);
await setCookie(one.page, 'offen=ja; Path=/; Max-Age=3600');
await one.page.waitForTimeout(4000);
const kept = await reopen(one);
check('Nachholen gescheitert: Cookie bleibt auf dem Geraet', kept.offen === 'ja' && kept.spaet === 'ja' && kept.dauer === 'ja', JSON.stringify(kept));
check('Nachholen gescheitert: noch nicht auf dem Server', (await serverCookies()) === 3, String(await serverCookies()));
await unblockUploads(one.context);
check('Danach hochgeladen', await waitFor(async () => (await serverCookies()) === 4, 30000, 500), String(await serverCookies()));

// 9) Profil zuruecksetzen: Server und Geraet leer, Einstellungen wieder Standard
const before = await info();
await one.page.click('#clear-data');
const table = await one.page.waitForSelector('#settings .settings-table table', { timeout: 20000 }).then((element) => element.textContent(), () => '');
check('Einstellungen Profil: Tabelle pro Website', table.includes('127.0.0.1'), table);
check('Einstellungen Profil: verbunden', (await one.page.textContent('#profile-state')).includes('Connected'));
const resetDone = one.page.waitForEvent('load', { timeout: 30000 }).then(() => true, () => false);
await one.page.click('#settings-reset-profile');
check('Profil zuruecksetzen laedt neu', await resetDone);
const after = await info();
check('Server: Profil leer mit neuer id', after.files.length === 0 && after.id !== before.id && !serverPrefs('settings') && !serverPrefs('bookmarks'), JSON.stringify(after));
one.results.clear();
await booted(one.page);
await go(one.page, siteA + 'lesen');
const cleared = lesen(await one.results.wait('lesen'));
check('Geraet 1 nach dem Zuruecksetzen leer', JSON.stringify(cleared) === JSON.stringify({ dauer: 'nein', sitzung: 'nein', nach: 'nein', spaet: 'nein', offen: 'nein', local: 'leer', klein: 'keine', gross: 'keine' }), JSON.stringify(cleared));
check('Einstellungen wieder Standard (DuckDuckGo)', (await searchEngine(one.page)) === 'duckduckgo');

// 10) Server nicht erreichbar: Hinweis, alles bleibt auf dem Geraet, auch geaenderte
// Einstellungen. Beim naechsten Start mit Server geht alles hoch.
await one.context.route('**/profile/**', (route) => route.abort());
one.results.clear();
await one.page.goto(stack.app({ url: siteA + 'schreiben' }));
check('Ohne Server: Daten geschrieben', (await one.results.wait('geschrieben')) === '1');
const offline = await one.page.waitForFunction(() => document.getElementById('status').textContent.includes('Profile server not reachable'), null, { timeout: 20000 }).then(() => true, () => false);
check('Ohne Server: Hinweis am Tab', offline, await one.page.textContent('#status'));
await openSettings(one.page, 'profile');
const localState = await one.page.locator('#profile-state').getAttribute('data-state');
check('Ohne Server: Einstellungen zeigen "nur lokal", Loeschen geht', localState === 'local' && (await one.page.textContent('#profile-state')).includes('not reachable')
  && await one.page.isEnabled('#settings-clear-site-data'), localState);
await one.page.click('#settings nav button[data-section=general]');
await one.page.selectOption('#setting-search', 'bing');
await one.page.keyboard.press('Escape');
await one.page.waitForTimeout(3000);
const local = await reopen(one);
check('Ohne Server: Daten bleiben auf dem Geraet', local.dauer === 'ja' && local.local === 'ja' && local.klein === 'wert' && local.gross === '600000', JSON.stringify(local));
check('Ohne Server: Einstellung bleibt', (await searchEngine(one.page)) === 'bing');
check('Ohne Server: nichts hochgeladen', (await info()).files.length === 0 && !serverPrefs('settings'));
await one.context.unroute('**/profile/**');
await reopen(one);
check('Wieder mit Server: Daten und Einstellung hochgeladen', await waitFor(async () => {
  profile = await info();
  return paths(profile).includes('cookies.db') && databases(profile, originA).length === 1 && serverPrefs('settings')?.searchEngine === 'bing';
}, 20000, 500), `${JSON.stringify(paths(profile))} ${JSON.stringify(serverPrefs('settings'))}`);
check('Wieder mit Server: Einstellung von hier', (await searchEngine(one.page)) === 'bing');

await one.context.close();
finish();
