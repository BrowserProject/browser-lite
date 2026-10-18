// Service workers and SharedWorker of the pages (engine/src/ServiceWorkerWasm.cpp): register,
// control through clients.claim(), intercept fetch (own answer, Cache API, blob, unhandled ->
// network), postMessage both ways, a navigation the worker answers, navigation preload
// (respondWith of the preloadResponse and its content in the worker) and large Cache API
// contents (as files, not in memory). After a restart: contents and preload still there, the
// new script comes without register() (background update after a navigation),
// WindowClient.navigate() reloads a window, registration.update() of the page during a
// background update, navigate() to a blocked target and showNotification() with
// notificationclick, which opens a view with clients.openWindow() or brings one to the front
// with WindowClient.focus(). Persistent storage, so the registration survives the restart.
//
//   node tests/core/serviceworker-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>SW test</title><body>Service Worker
<script>
const log = (text) => console.log('RESULT ' + text);
// SharedWorker: both objects talk to the same worker
if (typeof SharedWorker === 'undefined')
  log('shared=none');
else {
  const a = new SharedWorker('/shared.js');
  a.port.onmessage = (e) => {
    log('sharedA=' + e.data);
    const b = new SharedWorker('/shared.js');
    b.port.onmessage = (e) => log('sharedB=' + e.data);
    b.port.postMessage('b');
  };
  a.port.postMessage('a');
}
(async () => {
  if (!('serviceWorker' in navigator)) { log('sw=none'); return; }
  log('initialcontroller=' + !!navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('message', (e) => log('message=' + e.data));
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  log('registered=1');
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  log('controlled=1');
  log('fetch=' + await (await fetch('/hello')).text());
  log('cached=' + await (await fetch('/cached')).text());
  log('blob=' + await (await fetch('/blob')).text());
  log('network=' + await (await fetch('/network')).text());
  // Navigation preload: the state stays after a restart
  const preload = (await navigator.serviceWorker.ready).navigationPreload;
  const before = await preload.getState();
  log('preloadbefore=' + before.enabled + ':' + before.headerValue);
  await preload.enable();
  await preload.setHeaderValue('bl-test');
  navigator.serviceWorker.controller.postMessage('ping');
})().catch((e) => log('error=' + e));
</script>`;

// A page without register(): only the background update brings the new script
const NOREG_PAGE = `<!doctype html><title>Without register</title><body><script>
const log = (text) => console.log('RESULT ' + text);
log('noreg=' + !!navigator.serviceWorker.controller);
navigator.serviceWorker.addEventListener('controllerchange', () => navigator.serviceWorker.controller.postMessage('version'));
navigator.serviceWorker.addEventListener('message', (e) => {
  log('update=' + e.data);
  navigator.serviceWorker.controller.postMessage('navigate');
});
</script>`;

const NAVIGATED_PAGE = `<!doctype html><title>Reloaded</title><body><script>
navigator.serviceWorker.addEventListener('message', (e) => console.log('RESULT navresult=' + e.data));
console.log('RESULT navigated=' + !!navigator.serviceWorker.controller);
</script>`;

// While the background update waits for the script, the page calls update()
const UPDATE_PAGE = `<!doctype html><title>Update</title><body><script>
(async () => {
  while (await (await fetch('/sw-pending')).text() !== 'yes')
    await new Promise((r) => setTimeout(r, 100));
  const reg = await navigator.serviceWorker.getRegistration();
  await reg.update();
  console.log('RESULT pageupdate=ok');
  navigator.serviceWorker.addEventListener('message', (e) => console.log('RESULT blocked=' + e.data));
  navigator.serviceWorker.controller.postMessage('navigate-blocked');
})().catch((e) => console.log('RESULT pageupdate=' + e));
</script>`;

// Cache API: three contents of 16 MB, read again after a restart
const CACHE_BIG_PAGE = `<!doctype html><title>Cache large</title><body><script>
(async () => {
  const cache = await caches.open('big');
  for (let k = 0; k < 3; k++) {
    const data = new Uint8Array(16 << 20).fill(65 + k);
    data[data.length - 1] = 48 + k;
    await cache.put('/big' + k, new Response(data));
  }
  console.log('RESULT bigput=ok');
})().catch((e) => console.log('RESULT bigput=' + e));
</script>`;

const CACHE_CHECK_PAGE = `<!doctype html><title>Cache read</title><body><script>
(async () => {
  const cache = await caches.open('big');
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const data = new Uint8Array(await (await cache.match('/big' + k)).arrayBuffer());
    parts.push(data.length + ':' + data[0] + ':' + data[data.length >> 1] + ':' + data[data.length - 1]);
  }
  console.log('RESULT bigcheck=' + parts.join(','));
  await caches.delete('big');
  console.log('RESULT bigdeleted=' + !(await caches.has('big')));
})().catch((e) => console.log('RESULT bigcheck=' + e));
</script>`;

// A notification from showNotification(); the click on the button allows it
const NOTIFY_PAGE = `<!doctype html><title>Notification</title><body style="margin:0">
<button id="allow" style="width:100%;height:400px">Allow</button><script>
const log = (text) => console.log('RESULT ' + text);
navigator.serviceWorker.addEventListener('message', (e) => log((e.data.startsWith('focus:') ? 'focus=' : 'notifymsg=') + e.data));
document.getElementById('allow').addEventListener('click', async () => {
  log('notifypermission=' + await Notification.requestPermission());
  const reg = await navigator.serviceWorker.ready;
  navigator.serviceWorker.controller.postMessage('open-without-click');
  await reg.showNotification('Hello', { body: 'from the test', tag: 't1' });
  log('notifylist=' + (await reg.getNotifications()).map((n) => n.title + ':' + n.tag).join(','));
  navigator.serviceWorker.controller.postMessage('focus-without-click');
  await reg.showNotification('Focus', { tag: 'focus' });
});
log('notifyready=1');
</script>`;

const OPENED_PAGE = `<!doctype html><title>Opened</title><body><script>
navigator.serviceWorker.addEventListener('message', (e) => console.log('RESULT openedmsg=' + e.data));
console.log('RESULT opened=' + !!navigator.serviceWorker.controller);
</script>`;

// Header Service-Worker-Navigation-Preload per request
const preloadRequests = { '/preload-use': [], '/preload-read': [] };
// Navigation preload from the HTTP cache: fresh or revalidated (ETag, 304). Per request the
// header and If-None-Match
const cachedPreloads = { '/preload-fresh': [], '/preload-etag': [] };

let swVersion = 1;
let swScriptFetches = 0;
let holdScript = false;
let scriptPending = false;
// With umlauts and a wrong charset: worker scripts are always UTF-8, also in the background
// update
const sw = () => `const VERSION = ${swVersion};
const TEXT = 'äöü';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('v1').then((c) => c.put('/cached', new Response('cache-ok'))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/hello')
    e.respondWith(new Response('from-sw'));
  else if (url.pathname === '/cached')
    e.respondWith(caches.match('/cached'));
  else if (url.pathname === '/blob')
    e.respondWith(new Response(new Blob(['blob-ok'])));
  else if (url.pathname === '/sw-page')
    e.respondWith(new Response('<title>From the worker</title><script>console.log("RESULT swpage=" + !!navigator.serviceWorker.controller)</script>', { headers: { 'Content-Type': 'text/html' } }));
  else if (url.pathname === '/preload-use')
    e.respondWith(e.preloadResponse);
  else if (url.pathname === '/preload-read')
    e.respondWith(e.preloadResponse.then((r) => r.text()).then((text) => new Response('<title>Preload</title><script>console.log("RESULT preloadread=" + ' + JSON.stringify(text) + ')</script>', { headers: { 'Content-Type': 'text/html' } })));
  else if (url.pathname.startsWith('/preload-') && e.request.mode === 'navigate')
    e.respondWith(e.preloadResponse);
});
// A click on a notification from showNotification(): a new window, but never data: or file:
// (answer to the page with the notification)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // WindowClient.focus(): the view of the page comes to the front
  if (e.notification.tag === 'focus') {
    e.waitUntil(self.clients.matchAll().then((clients) => clients.find((c) => new URL(c.url).pathname === '/notify').focus())
      .then((client) => client.postMessage('focus:' + new URL(client.url).pathname)));
    return;
  }
  const blocked = Promise.all(['data:text/html,<title>x</title>', 'file:///data/cachestorage/'].map((url) => self.clients.openWindow(url).then(() => 'opened', (error) => error.name)))
    .then((names) => self.clients.matchAll().then((clients) => clients.filter((c) => new URL(c.url).pathname === '/notify').forEach((c) => c.postMessage('blocked:' + names.join(',')))));
  const opened = self.clients.openWindow('/opened').then((client) => client.postMessage('client:' + new URL(client.url).pathname + ':' + e.notification.tag));
  e.waitUntil(Promise.all([blocked, opened]));
});
self.addEventListener('message', (e) => {
  if (e.data === 'version')
    e.source.postMessage('version:' + VERSION + ':' + TEXT);
  else if (e.data === 'navigate')
    e.source.navigate('/navigated').then((client) => client.postMessage('client:' + new URL(client.url).pathname), (error) => console.log('RESULT navigate=' + error.name));
  else if (e.data === 'navigate-blocked')
    e.source.navigate('http://127.0.0.1:1/').then((client) => e.source.postMessage('resolved:' + client), (error) => e.source.postMessage(error.name));
  else if (e.data === 'focus-without-click')
    e.source.focus().then(() => e.source.postMessage('focus:focused'), (error) => e.source.postMessage('focus:' + error.name));
  else if (e.data === 'open-without-click')
    self.clients.openWindow('/opened').then(() => e.source.postMessage('window'), (error) => e.source.postMessage('nowindow:' + error.name));
  else
    e.source.postMessage('pong:' + e.data);
});
`;

const SHARED = `
let connections = 0;
onconnect = (e) => {
  connections++;
  const port = e.ports[0];
  port.onmessage = (m) => port.postMessage(m.data + ':' + connections);
};
`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/shared.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SHARED);
  if (req.url === '/sw.js') {
    if (req.headers['service-worker'] === 'script') swScriptFetches++;
    const reply = () =>
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=iso-8859-1' }).end(sw());
    if (!holdScript) return reply();
    holdScript = false;
    scriptPending = true;
    return setTimeout(() => {
      scriptPending = false;
      reply();
    }, 3000);
  }
  if (req.url === '/sw-pending')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(scriptPending ? 'yes' : 'no');
  if (req.url === '/update')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(UPDATE_PAGE);
  if (req.url === '/noreg')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(NOREG_PAGE);
  if (req.url === '/navigated')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(NAVIGATED_PAGE);
  if (req.url === '/network')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('net');
  if (req.url in cachedPreloads) {
    const requests = cachedPreloads[req.url];
    requests.push(
      (req.headers['service-worker-navigation-preload'] || 'none') +
        ':' +
        (req.headers['if-none-match'] || 'none'),
    );
    const etag = req.url === '/preload-etag';
    if (etag && req.headers['if-none-match'] === '"v1"')
      return res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'no-cache' }).end();
    const name = etag ? 'preloadetag' : 'preloadfresh';
    return res
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(etag
          ? { ETag: '"v1"', 'Cache-Control': 'no-cache' }
          : { 'Cache-Control': 'max-age=600' }),
      })
      .end(
        `<title>Preload</title><script>console.log('RESULT ${name}=${requests.length}')</script>`,
      );
  }
  if (req.url in preloadRequests) {
    const header = req.headers['service-worker-navigation-preload'] || 'none';
    preloadRequests[req.url].push(header);
    if (req.url === '/preload-use')
      return res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<title>Preload</title><script>console.log('RESULT preloaduse=${header}')</script>`);
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('preload-body:' + header);
  }
  if (req.url === '/notify')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(NOTIFY_PAGE);
  if (req.url === '/opened')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(OPENED_PAGE);
  if (req.url === '/cache-big')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CACHE_BIG_PAGE);
  if (req.url === '/cache-check')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CACHE_CHECK_PAGE);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'serviceworker-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
// Host notifications: headless has none, a stand-in records them so the test can click them
await page.addInitScript(() => {
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
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms, () => results.has('error'));

// After a navigation the server checks the script (1 s later). Only when that is done does the
// next navigation get its own check,
// else WebKit merges the two.
async function softUpdateDone(fetchesBefore) {
  const end = Date.now() + 30000;
  while (swScriptFetches <= fetchesBefore && Date.now() < end) await page.waitForTimeout(100);
  await page.waitForTimeout(1000);
  return swScriptFetches > fetchesBefore;
}

const appURL = stack.app({ url: siteURL, log: '1', persistent: '1' });
await openHost(page, appURL);
check(
  'navigator.serviceWorker there',
  (await result('registered')) === '1' || results.get('sw') !== 'none',
  results.get('error') || '',
);
check('registered (ready)', (await result('registered')) === '1', results.get('error') || '');
check(
  'no worker at the start',
  results.get('initialcontroller') === 'false',
  results.get('initialcontroller'),
);
check('page gets controlled (clients.claim)', (await result('controlled', 30000)) === '1');
check(
  'fetch answered by the worker',
  (await result('fetch', 30000)) === 'from-sw',
  results.get('fetch'),
);
check(
  'answer from the Cache API of the worker',
  (await result('cached', 30000)) === 'cache-ok',
  results.get('cached'),
);
check('answer with a blob', (await result('blob', 30000)) === 'blob-ok', results.get('blob'));
check(
  'unhandled goes to the network',
  (await result('network', 30000)) === 'net',
  results.get('network'),
);
check(
  'postMessage both ways',
  (await result('message', 30000)) === 'pong:ping',
  results.get('message'),
);

check(
  'SharedWorker answers',
  (await result('sharedA', 30000)) === 'a:1',
  results.get('sharedA') || results.get('shared'),
);
check(
  'second SharedWorker object uses the same worker',
  (await result('sharedB', 30000)) === 'b:2',
  results.get('sharedB'),
);

// A navigation the worker answers (the page does not exist on the server)
await page.evaluate(() => window.blTest.eval('location.href = "/sw-page"'));
check(
  'navigation answered by the worker and controlled',
  (await result('swpage', 30000)) === 'true',
  results.get('swpage'),
);
check(
  'navigation preload off at the start',
  results.get('preloadbefore') === 'false:true',
  results.get('preloadbefore'),
);

// Navigation preload: the answer from the network (with the header) as the page and read by the
// worker, one request each
await page.evaluate(() => window.blTest.eval('location.href = "/preload-use"'));
check(
  'navigation preload: respondWith(preloadResponse)',
  (await result('preloaduse', 30000)) === 'bl-test',
  results.get('preloaduse'),
);
check(
  'navigation preload: one request',
  preloadRequests['/preload-use'].join() === 'bl-test',
  preloadRequests['/preload-use'].join(),
);
await page.evaluate(() => window.blTest.eval('location.href = "/preload-read"'));
check(
  'navigation preload: the worker reads the content',
  (await result('preloadread', 30000)) === 'preload-body:bl-test',
  results.get('preloadread'),
);
check(
  'navigation preload: one request when reading',
  preloadRequests['/preload-read'].join() === 'bl-test',
  preloadRequests['/preload-read'].join(),
);

// Navigation preload through the HTTP cache: fetch() of the page puts the answer into the cache
// (asynchronously, so wait a moment), the navigation afterwards takes it fresh from there or
// revalidates it with If-None-Match (304)
for (const [path, name, expected] of [
  ['/preload-fresh', 'preloadfresh', 'none:none'],
  ['/preload-etag', 'preloadetag', 'none:none,bl-test:"v1"'],
]) {
  await page.evaluate(
    (target) =>
      window.blTest.eval(
        `fetch('${target}').then((r) => r.text()).then(() => setTimeout(() => { location.href = '${target}'; }, 1000))`,
      ),
    path,
  );
  check(
    `navigation preload from the HTTP cache (${name})`,
    (await result(name, 30000)) === '1' && cachedPreloads[path].join() === expected,
    `${results.get(name)} ${cachedPreloads[path].join()}`,
  );
}

// Cache API: large contents live in files, not in the memory of the engine
async function engineMallocMB() {
  const line = page.waitForEvent('console', {
    predicate: (msg) => /malloc used \d+ MB/.test(msg.text()),
    timeout: 30000,
  });
  await page.evaluate(() => window.blTest.memory(0));
  return Number(/malloc used (\d+) MB/.exec((await line).text())[1]);
}
// Files with Cache API contents in the OPFS of the host page (/data/cachestorage/*.bodies)
const bodyFiles = () =>
  page.evaluate(async () => {
    let count = 0;
    const walk = async (directory, isBodies) => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle, name.endsWith('.bodies'));
        else if (isBodies) count++;
      }
    };
    await walk(await navigator.storage.getDirectory(), false);
    return count;
  });
const mallocBefore = await engineMallocMB();
await page.evaluate(() => window.blTest.eval('location.href = "/cache-big"'));
check('Cache API: 48 MB stored', (await result('bigput', 60000)) === 'ok', results.get('bigput'));
await page.waitForTimeout(1500);
const mallocAfter = await engineMallocMB();
check(
  'Cache API: contents not in memory',
  mallocAfter - mallocBefore < 24,
  `${mallocBefore} -> ${mallocAfter} MB`,
);
check('Cache API: contents as files', (await bodyFiles()) === 4, String(await bodyFiles()));

// Restart of the browser: the registration comes from disk (/data), the page is controlled from
// the start
await page.waitForTimeout(7000);
results.clear();
const restartFetches = swScriptFetches;
await openHost(page, appURL);
check(
  'after a restart: page controlled right away',
  (await result('initialcontroller', 60000)) === 'true',
  results.get('initialcontroller'),
);
check(
  'after a restart: fetch answered by the worker',
  (await result('fetch', 30000)) === 'from-sw',
  results.get('fetch'),
);
check(
  'after a restart: Cache API of the worker still there',
  (await result('cached', 30000)) === 'cache-ok',
  results.get('cached'),
);
check(
  'after a restart: script checked in the background',
  await softUpdateDone(restartFetches),
  `${swScriptFetches - restartFetches} fetches`,
);
check(
  'after a restart: navigation preload still on',
  (await result('preloadbefore', 30000)) === 'true:bl-test',
  results.get('preloadbefore'),
);
const checkFetches = swScriptFetches;
await page.evaluate(() => window.blTest.eval('location.href = "/cache-check"'));
check(
  'after a restart: large Cache API contents read',
  (await result('bigcheck', 60000)) === '16777216:65:65:48,16777216:66:66:49,16777216:67:67:50',
  results.get('bigcheck'),
);
check(
  'Cache API: cache deleted',
  (await result('bigdeleted', 30000)) === 'true',
  results.get('bigdeleted'),
);
await page.waitForTimeout(1500);
check(
  'Cache API: files of the deleted cache gone',
  (await bodyFiles()) === 1,
  String(await bodyFiles()),
);
await softUpdateDone(checkFetches);

// A new script on the server, the page does not register: after the navigation the script is
// checked in the background, the new worker takes over (skipWaiting, clients.claim)
swVersion = 2;
const fetchesBefore = swScriptFetches;
await page.evaluate(() => window.blTest.eval('location.href = "/noreg"'));
check(
  'page without register() controlled',
  (await result('noreg', 30000)) === 'true',
  results.get('noreg'),
);
check(
  'background update: new script active (as UTF-8)',
  (await result('update', 60000)) === 'version:2:äöü',
  results.get('update'),
);
check(
  'background update: script loaded with the Service-Worker header',
  swScriptFetches > fetchesBefore,
  `${swScriptFetches - fetchesBefore} fetches`,
);

// WindowClient.navigate(): the worker reloads the window and gets the new client
check(
  'WindowClient.navigate: new page controlled',
  (await result('navigated', 30000)) === 'true',
  results.get('navigate') || results.get('navigated'),
);
check(
  'WindowClient.navigate: client of the new page',
  (await result('navresult', 30000)) === 'client:/navigated',
  results.get('navresult'),
);

// registration.update() of the page while the background update after the navigation still
// waits for the script: runs afterwards
check(
  'after WindowClient.navigate: script checked in the background',
  await softUpdateDone(fetchesBefore + 1),
);
holdScript = true;
await page.evaluate(() => window.blTest.eval('location.href = "/update"'));
check(
  'update() of the page during a background update done',
  (await result('pageupdate', 30000)) === 'ok',
  results.get('pageupdate'),
);

// Blocked port: loading ends before a request starts
check(
  'WindowClient.navigate to a blocked target fails',
  (await result('blocked', 30000)) === 'TypeError',
  results.get('blocked'),
);

// A notification from showNotification(): its click goes to the worker as notificationclick,
// which may then open a view with clients.openWindow()
const tabCount = () => page.evaluate(() => window.blTest.views().length);
const tabsBefore = await tabCount();
await page.evaluate(() => window.blTest.eval('location.href = "/notify"'));
check('page for notifications loaded', (await result('notifyready', 30000)) === '1');
await page.evaluate(() => {
  window.blHost.permissionAnswer = 'grant';
});
const origin = await canvasOrigin(page);
await page.mouse.click(origin.x + 200, origin.y + 100);
check(
  'notifications allowed',
  (await result('notifypermission', 15000)) === 'granted',
  results.get('notifypermission'),
);
check(
  'clients.openWindow without a click refused',
  (await result('notifymsg', 30000)) === 'nowindow:InvalidAccessError',
  results.get('notifymsg'),
);
check(
  'getNotifications finds it',
  (await result('notifylist', 30000)) === 'Hello:t1',
  results.get('notifylist'),
);
const shown = await page
  .waitForFunction(() => window.__blNotifications.some((n) => n.title === 'Hello'), null, {
    timeout: 15000,
  })
  .then(
    () => true,
    () => false,
  );
check('notification shown in the host', shown);
results.delete('notifymsg');
await page.evaluate(() =>
  window.__blNotifications.find((n) => n.title === 'Hello').dispatchEvent(new Event('click')),
);
check(
  'notificationclick: clients.openWindow opens a controlled view',
  (await result('opened', 30000)) === 'true',
  results.get('opened'),
);
check(
  'clients.openWindow gives the client of the new view',
  (await result('openedmsg', 30000)) === 'client:/opened:t1',
  results.get('openedmsg'),
);
check(
  'clients.openWindow refuses data: and file:',
  (await result('notifymsg', 30000)) === 'blocked:TypeError,TypeError',
  results.get('notifymsg'),
);
check(
  'new view in the host page',
  (await tabCount()) === tabsBefore + 1,
  `${tabsBefore} -> ${await tabCount()}`,
);

// WindowClient.focus() only after notificationclick: brings the view of the page to the front
const activeTitle = () => page.evaluate(() => window.blTest.view()?.title);
check(
  'WindowClient.focus without a click refused',
  (await result('focus', 30000)) === 'focus:InvalidAccessError',
  results.get('focus'),
);
results.delete('focus');
check(
  'before WindowClient.focus: the new view in front',
  (await activeTitle()) === 'Opened',
  await activeTitle(),
);
await page.evaluate(() =>
  window.__blNotifications.find((n) => n.title === 'Focus').dispatchEvent(new Event('click')),
);
const focused = await result('focus', 30000);
const front = await page
  .waitForFunction(() => window.blTest.view()?.title === 'Notification', null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check(
  'notificationclick: WindowClient.focus brings the view to the front',
  focused === 'focus:/notify' && front,
  `${focused}, ${await activeTitle()}`,
);

await browser.close();
finish();
