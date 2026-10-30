// The profile on the server (packages/profile, packages/server/src/profile.ts) in the demo: stay
// signed in on a second device (a new Chromium profile at the same server) with cookie, session
// cookie, localStorage and a small IndexedDB; large databases stay on the device, one that grew
// over the limit drops out of the profile; deleted locally is gone on the server too; takeover
// and reset by the other device; settings (already at the first start of the other device) and
// bookmarks in the profile; what did not go up
// before closing comes at the next start and is not overwritten by the server; reset the profile;
// without the server everything stays local and goes up at the next start with the server. The
// settings page itself: settings-test.mjs.
//
//   node tests/demo/profile-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
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

timeLimit(6 * TIMEOUT);

const html = (body) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh">${body}`;
const SITE_A = {
  // A cookie with expiry, a session cookie, localStorage, a small and a large IndexedDB
  write: `<title>Write</title><script>
(async () => {
  localStorage.setItem('login', 'yes');
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
  await put('small', 'value');
  await put('large', new Uint8Array(600000).fill(7));
  console.log('RESULT written=1');
})();
</script>`,
  // IndexedDB "growing" with ?n bytes
  grow: `<title>Grow</title><script>
const open = indexedDB.open('growing', 1);
open.onupgradeneeded = () => open.result.createObjectStore('w');
open.onsuccess = () => {
  const size = Number(new URLSearchParams(location.search).get('n'));
  const tx = open.result.transaction('w', 'readwrite');
  tx.objectStore('w').put(new Uint8Array(size).fill(1), 'x');
  tx.oncomplete = () => { open.result.close(); console.log('RESULT grown=' + size); };
};
</script>`,
  read: `<title>Read</title><script>
(async () => {
  const cookie = (name) => (document.cookie.match(new RegExp('(^|; )' + name + '=(\\\\w+)')) || [])[2] || 'no';
  const names = (await indexedDB.databases()).map((db) => db.name);
  const get = (name) => !names.includes(name) ? 'none' : new Promise((resolve) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => {
      const request = open.result.transaction('w').objectStore('w').get('x');
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result == null ? 'empty' : typeof request.result === 'string' ? request.result : String(request.result.length));
      };
      request.onerror = () => resolve('error');
    };
    open.onerror = () => resolve('error');
  });
  console.log('RESULT read=' + [...['lasting', 'session', 'later', 'late', 'pending'].map((name) => name + ':' + cookie(name)),
    'local:' + (localStorage.getItem('login') || 'empty'), 'small:' + await get('small'), 'large:' + await get('large'),
    'tz:' + Intl.DateTimeFormat().resolvedOptions().timeZone, 'lang:' + navigator.language].join(','));
})();
</script>`,
  delete: `<title>Delete</title><script>
const request = indexedDB.deleteDatabase('small');
request.onsuccess = request.onerror = () => console.log('RESULT deleted=1');
</script>`,
};
const SITE_B = {
  large: `<title>Large</title><script>localStorage.setItem('large', 'x'.repeat(200000)); console.log('RESULT largewritten=1');</script>`,
  read: `<title>Large read</title><script>console.log('RESULT largeread=' + (localStorage.getItem('large') || '').length);</script>`,
};

const site = (pages) =>
  serve((req, res) => {
    const name = req.url.slice(1).split('?')[0];
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (name === 'write')
      headers['Set-Cookie'] = ['lasting=yes; Path=/; Max-Age=86400', 'session=yes; Path=/'];
    res.writeHead(pages[name] ? 200 : 404, headers).end(html(pages[name] || ''));
  });
const { url: siteA } = await site(SITE_A);
const { url: siteB } = await site(SITE_B);
// Origin in the OPFS and the profile, as WebKit writes it
const originA = `http_127.0.0.1_${new URL(siteA).port}`;
const originB = `http_127.0.0.1_${new URL(siteB).port}`;

const stack = await startStack({ app: 'demo', token: 'profile-token-0123456789abcdef' });
const info = async () => (await fetch(`${stack.origin}/profile/info`)).json();
const paths = (profile) => profile.files.map((file) => file.path);
const databases = (profile, origin) => [
  ...new Set(
    paths(profile)
      .filter((p) => p.startsWith(`indexeddb/v1/${origin}/`))
      .map((p) => path.posix.dirname(p)),
  ),
];
// Cookies of 127.0.0.1 in cookies.db on the server (node:sqlite)
const serverCookies = async () =>
  (await info()).cookies?.find((c) => c.domain === '127.0.0.1')?.count || 0;
const serverPrefs = (name) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(stack.profileDir, 'prefs', name + '.json'), 'utf8'),
    );
  } catch {
    return null;
  }
};

// A device: its own Chromium profile, the language and time zone of the host fixed
async function device() {
  const context = await launchProfile({
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1100, height: 800 },
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('dialog', (dialog) => dialog.accept());
  return { context, page, results: collect(page) };
}
async function go(page, address) {
  await page.click('#address');
  await page.fill('#address', address);
  await page.press('#address', 'Enter');
}
const booted = (page) =>
  page.waitForFunction(() => document.getElementById('boot').hidden, null, { timeout: TIMEOUT });
// The demo again with ?url=siteA/read, returns what the page reads
async function reopen(dev) {
  dev.results.clear();
  await dev.page.goto(stack.app({ url: siteA + 'read' }));
  return read(await dev.results.wait('read'));
}
// Files in the OPFS of a device under dir (for debugging)
const opfsFiles = (page, dir) =>
  page
    .evaluate(async (name) => {
      const files = [];
      const walk = async (handle, prefix) => {
        for await (const [entry, child] of handle.entries()) {
          if (child.kind === 'directory') await walk(child, prefix + entry + '/');
          else files.push(prefix + entry + ':' + (await child.getFile()).size);
        }
      };
      await walk(
        await (
          await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
        ).getDirectoryHandle(name),
        name + '/',
      );
      return files;
    }, dir)
    .catch((error) => [String(error)]);
const read = (text) => Object.fromEntries((text || '').split(',').map((pair) => pair.split(':')));
const profileStatus = (page) => page.evaluate(() => window.blTest.profile.status);
const searchEngine = (page) => page.evaluate(() => window.blTest.settings().searchEngine);
// Device 1 uploads what changed right after its start; before another device takes over, that
// upload must be done (else it gets 'taken' instead of the later 'reset'): the server stays
// unchanged for 3 s
async function serverSettled() {
  let last = '';
  let since = Date.now();
  for (
    const end = Date.now() + 30000;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 500))
  ) {
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
const setCookie = (page, cookie) =>
  page.evaluate((text) => window.blTest.eval(`document.cookie = ${JSON.stringify(text)}`), cookie);
// Uploads into the profile fail (network gone), open works
const blockUploads = (context) =>
  context.route('**/profile/files/**', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
const unblockUploads = (context) => context.unroute('**/profile/files/**');
async function openSettings(page, section) {
  await page.click('#menu-button');
  await page.locator('#side-panel .panel-menu-item', { hasText: 'Settings' }).click();
  await page.click(`#settings nav button[data-section=${section}]`);
}

// 1) Device 1 writes, the sync brings only the small databases to the server
const one = await device();
await one.page.goto(stack.app({ url: siteA + 'write' }));
check('device 1: data written', (await one.results.wait('written')) === '1');
await go(one.page, siteB + 'large');
check('device 1: large localStorage written', (await one.results.wait('largewritten')) === '1');
let profile = null;
const synced = await waitFor(
  async () => {
    profile = await info();
    const cookies = profile.cookies?.find((c) => c.domain === '127.0.0.1');
    return (
      paths(profile).includes('cookies.db') &&
      paths(profile).includes(`localstorage/${originA}.localstorage`) &&
      databases(profile, originA).length === 1 &&
      (!profile.cookies || cookies?.count === 2)
    );
  },
  60000,
  1000,
);
check(
  'server: cookies.db, small localStorage and small IndexedDB in the profile',
  synced,
  JSON.stringify(paths(profile)),
);
if (profile.cookies)
  check(
    'server: two cookies, one for the session',
    JSON.stringify(profile.cookies) ===
      JSON.stringify([{ domain: '127.0.0.1', count: 2, session: 1 }]),
    JSON.stringify(profile.cookies),
  );
// The engine replaces the file by a rename while writing it: reading can fail for a moment
let localBig = 0;
await waitFor(async () => {
  localBig = await one.page
    .evaluate(async (name) => {
      const dir = await (
        await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
      ).getDirectoryHandle('localstorage');
      return (await (await dir.getFileHandle(name)).getFile()).size;
    }, `${originB}.localstorage`)
    .catch(() => 0);
  return localBig > 256 * 1024;
}, 10000);
check(
  'server: large IndexedDB and large localStorage not in the profile, they stay on device 1',
  databases(profile, originA).length === 1 &&
    !paths(profile).includes(`localstorage/${originB}.localstorage`) &&
    localBig > 256 * 1024,
  `${JSON.stringify(paths(profile))}, local ${localBig} B`,
);
await go(one.page, siteA + 'grow?n=10');
await one.results.wait('grown');
check(
  'new small IndexedDB in the profile',
  await waitFor(async () => databases((profile = await info()), originA).length === 2, 30000, 500),
  JSON.stringify(paths(profile)),
);
one.results.delete('grown');
await go(one.page, siteA + 'grow?n=400000');
await one.results.wait('grown');
check(
  'grown over the limit: gone on the server',
  await waitFor(async () => databases((profile = await info()), originA).length === 1, 30000, 500),
  JSON.stringify(paths(profile)),
);

// 2) Device 2 (a new Chromium profile): signed in like on device 1
const two = await device();
await two.page.goto(stack.app({ url: siteA + 'read' }));
const onTwo = read(await two.results.wait('read'));
check(
  'device 2: cookie, localStorage and small IndexedDB there',
  onTwo.lasting === 'yes' && onTwo.local === 'yes' && onTwo.small === 'value',
  JSON.stringify(onTwo),
);
check('device 2: session cookie there', onTwo.session === 'yes', JSON.stringify(onTwo));
check('device 2: large IndexedDB not transferred', onTwo.large === 'none', JSON.stringify(onTwo));
await go(two.page, siteB + 'read');
check(
  'device 2: large localStorage not transferred',
  (await two.results.wait('largeread')) === '0',
  two.results.get('largeread'),
);

// 3) Device 1 notices the takeover at the next write and stops
await setCookie(one.page, 'later=yes; Path=/; Max-Age=3600');
const notice = await one.page
  .waitForSelector('#profile-notice:not([hidden])', { timeout: 30000 })
  .then(
    (element) => element.textContent(),
    () => '',
  );
check(
  'device 1: notice "opened on another device" with Reload',
  notice.includes('opened on another device') && notice.includes('Reload'),
  notice,
);
check('device 1: sync stopped', (await profileStatus(one.page)) === 'taken');

// 4) Device 2 deletes a database, changes settings (also ones that apply at the start of the
// engine) and adds a bookmark
await go(two.page, siteA + 'delete');
check('device 2: database deleted', (await two.results.wait('deleted')) === '1');
const deleted = await waitFor(
  async () => databases((profile = await info()), originA).length === 0,
  60000,
  1000,
);
check(
  'database deleted locally is gone on the server too',
  deleted,
  JSON.stringify(paths(profile)) +
    ' local ' +
    JSON.stringify(await opfsFiles(two.page, 'indexeddb')),
);
await openSettings(two.page, 'general');
await two.page.selectOption('#setting-search', 'google');
await two.page.keyboard.press('Escape');
await two.page.evaluate(() => {
  const { profile } = window.blTest;
  profile.savePrefs('settings', {
    ...profile.prefs('settings'),
    timeZone: 'Asia/Tokyo',
    languages: 'fr-CH',
    zoom: 1.25,
  });
});
await two.page.click('#bookmark');
check(
  'settings and bookmarks on the server',
  await waitFor(
    () =>
      serverPrefs('settings')?.searchEngine === 'google' &&
      serverPrefs('settings')?.timeZone === 'Asia/Tokyo' &&
      serverPrefs('bookmarks')?.length === 1,
    10000,
  ),
  JSON.stringify([serverPrefs('settings'), serverPrefs('bookmarks')]),
);

// 5) Device 1 reloaded: takes over again, the server counts (cookie not uploaded gone, deleted
// database gone), large databases stay as a cache, settings of device 2
const onOne = await reopen(one);
check(
  'device 1 again: state of the server',
  onOne.lasting === 'yes' &&
    onOne.session === 'yes' &&
    onOne.later === 'no' &&
    onOne.local === 'yes' &&
    onOne.small === 'none',
  JSON.stringify(onOne),
);
// Device 1 had the old settings: the ones of the server apply at this start already
check(
  'device 1 again: time zone and language of device 2 at the first start',
  onOne.tz === 'Asia/Tokyo' && onOne.lang === 'fr-CH',
  JSON.stringify(onOne),
);
check(
  'device 1 again: zoom of device 2, profile connected',
  (await one.page.evaluate(() => window.blTest.view().zoom)) === 1.25 &&
    (await profileStatus(one.page)) === 'connected',
);
check(
  'device 1 again: large IndexedDB still there',
  onOne.large === '600000',
  JSON.stringify(onOne),
);
await go(one.page, siteB + 'read');
check(
  'device 1 again: large localStorage still there',
  (await one.results.wait('largeread')) === '200000',
  one.results.get('largeread'),
);
check(
  'device 1 again: search engine and bookmark of device 2',
  (await searchEngine(one.page)) === 'google' &&
    (await one.page.evaluate(() => window.blTest.profile.prefs('bookmarks')?.length)) === 1,
);
check(
  'device 1 again: no notice',
  await one.page.evaluate(() => document.getElementById('profile-notice').hidden),
);

// 6) Device 2 takes over and clears the site data: device 1 gets "was reset", settings and
// bookmarks stay in the profile
check('device 1 again: sync done', await serverSettled());
const idBefore = (await info()).id;
two.results.clear();
await two.page.goto(stack.app({ url: siteA + 'read' }));
await two.results.wait('read');
// A setting the running engine takes without a new start
await two.page.evaluate(() => {
  const { profile } = window.blTest;
  profile.savePrefs('settings', { ...profile.prefs('settings'), languages: 'it-CH' });
});
await waitFor(() => serverPrefs('settings')?.languages === 'it-CH', 10000);
await two.page.click('#clear-data');
const twoReloaded = two.page.waitForEvent('load', { timeout: 30000 }).then(
  () => true,
  () => false,
);
await two.page.click('#settings-clear-site-data');
check('device 2: clearing site data reloads', await twoReloaded);
profile = await info();
check(
  'server: site data gone, settings and bookmarks stay',
  profile.id !== idBefore &&
    profile.files.length === 0 &&
    serverPrefs('settings')?.searchEngine === 'google' &&
    serverPrefs('bookmarks')?.length === 1,
  JSON.stringify(paths(profile)),
);
await setCookie(one.page, 'later=yes; Path=/; Max-Age=3600');
const resetNotice = await one.page
  .waitForSelector('#profile-notice:not([hidden])', { timeout: 30000 })
  .then(
    (element) => element.textContent(),
    () => '',
  );
check(
  'device 1: notice "was reset"',
  resetNotice.includes('was reset') && (await profileStatus(one.page)) === 'reset',
  resetNotice,
);
await booted(two.page);
await two.context.close();

// 7) What changed shortly before closing and was not uploaded any more reaches the server at the
// next start of the same device
const fresh = await reopen(one);
check(
  'device 1 after clearing on device 2: signed out',
  fresh.lasting === 'no' && fresh.local === 'empty',
  JSON.stringify(fresh),
);
check(
  'device 1: language of device 2 at the first start',
  fresh.lang === 'it-CH' && fresh.tz === 'Asia/Tokyo',
  JSON.stringify(fresh),
);
one.results.clear();
await go(one.page, siteA + 'write');
await one.results.wait('written');
check(
  'device 1: two cookies on the server',
  await waitFor(async () => (await serverCookies()) === 2, 30000, 500),
  String(await serverCookies()),
);
await blockUploads(one.context);
await setCookie(one.page, 'late=yes; Path=/; Max-Age=3600');
await one.page.waitForTimeout(4000);
check(
  'upload blocked: cookie not on the server',
  (await serverCookies()) === 2,
  String(await serverCookies()),
);
await one.page.goto('about:blank');
await unblockUploads(one.context);
const late = await reopen(one);
check(
  'next start: the cookie from before closing there and on the server',
  late.late === 'yes' && (await waitFor(async () => (await serverCookies()) === 3, 10000, 250)),
  `${JSON.stringify(late)} server ${await serverCookies()}`,
);

// 8) When catching up at the start fails, the server does not overwrite the change, it goes up
// later
await blockUploads(one.context);
await setCookie(one.page, 'pending=yes; Path=/; Max-Age=3600');
await one.page.waitForTimeout(4000);
const kept = await reopen(one);
check(
  'catching up failed: the cookie stays on the device',
  kept.pending === 'yes' && kept.late === 'yes' && kept.lasting === 'yes',
  JSON.stringify(kept),
);
check(
  'catching up failed: not on the server yet',
  (await serverCookies()) === 3,
  String(await serverCookies()),
);
await unblockUploads(one.context);
check(
  'uploaded afterwards',
  await waitFor(async () => (await serverCookies()) === 4, 30000, 500),
  String(await serverCookies()),
);

// 9) Reset the profile: server and device empty, settings default again
const before = await info();
await one.page.click('#clear-data');
const table = await one.page
  .waitForSelector('#settings .settings-table table', { timeout: 20000 })
  .then(
    (element) => element.textContent(),
    () => '',
  );
check('settings profile: table per site', table.includes('127.0.0.1'), table);
check(
  'settings profile: connected',
  (await one.page.textContent('#profile-state')).includes('Connected'),
);
const resetDone = one.page.waitForEvent('load', { timeout: 30000 }).then(
  () => true,
  () => false,
);
await one.page.click('#settings-reset-profile');
check('reset profile reloads', await resetDone);
const after = await info();
check(
  'server: profile empty with a new id',
  after.files.length === 0 &&
    after.id !== before.id &&
    !serverPrefs('settings') &&
    !serverPrefs('bookmarks'),
  JSON.stringify(after),
);
one.results.clear();
await booted(one.page);
await go(one.page, siteA + 'read');
const cleared = read(await one.results.wait('read'));
check(
  'device 1 empty after the reset',
  JSON.stringify(cleared) ===
    JSON.stringify({
      lasting: 'no',
      session: 'no',
      later: 'no',
      late: 'no',
      pending: 'no',
      local: 'empty',
      small: 'none',
      large: 'none',
      tz: 'Europe/Zurich',
      lang: 'de-CH',
    }),
  JSON.stringify(cleared),
);
check(
  'settings default again (DuckDuckGo, time zone and language of the host)',
  (await searchEngine(one.page)) === 'duckduckgo',
);

// 10) Server not reachable: a notice, everything stays on the device, also changed settings. At
// the next start with the server everything goes up.
await one.context.route('**/profile/**', (route) => route.abort());
one.results.clear();
await one.page.goto(stack.app({ url: siteA + 'write' }));
check('without the server: data written', (await one.results.wait('written')) === '1');
const offline = await one.page
  .waitForFunction(
    () => document.getElementById('status').textContent.includes('Profile server not reachable'),
    null,
    { timeout: 20000 },
  )
  .then(
    () => true,
    () => false,
  );
check('without the server: notice at the tab', offline, await one.page.textContent('#status'));
await openSettings(one.page, 'profile');
const localState = await one.page.locator('#profile-state').getAttribute('data-state');
check(
  'without the server: settings show "local only", deleting works',
  localState === 'local' &&
    (await one.page.textContent('#profile-state')).includes('not reachable') &&
    (await one.page.isEnabled('#settings-clear-site-data')),
  localState,
);
await one.page.click('#settings nav button[data-section=general]');
await one.page.selectOption('#setting-search', 'bing');
await one.page.keyboard.press('Escape');
await one.page.waitForTimeout(3000);
const local = await reopen(one);
check(
  'without the server: data stays on the device',
  local.lasting === 'yes' &&
    local.local === 'yes' &&
    local.small === 'value' &&
    local.large === '600000',
  JSON.stringify(local),
);
check('without the server: the setting stays', (await searchEngine(one.page)) === 'bing');
check(
  'without the server: nothing uploaded',
  (await info()).files.length === 0 && !serverPrefs('settings'),
);
await one.context.unroute('**/profile/**');
await reopen(one);
check(
  'with the server again: data and setting uploaded',
  await waitFor(
    async () => {
      profile = await info();
      return (
        paths(profile).includes('cookies.db') &&
        databases(profile, originA).length === 1 &&
        serverPrefs('settings')?.searchEngine === 'bing'
      );
    },
    20000,
    500,
  ),
  `${JSON.stringify(paths(profile))} ${JSON.stringify(serverPrefs('settings'))}`,
);
check('with the server again: the setting from here', (await searchEngine(one.page)) === 'bing');

await one.context.close();
finish();
