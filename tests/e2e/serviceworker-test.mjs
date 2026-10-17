// End-to-End Test fuer Service Worker und SharedWorker (engine/src/ServiceWorkerWasm.cpp):
// registrieren, Kontrolle per clients.claim(), Fetch abfangen (eigene Antwort,
// Cache API, Blob, nicht behandelt -> Netz), postMessage hin und zurueck, eine
// Navigation, die der Worker beantwortet, Navigation Preload (respondWith der
// preloadResponse und ihr Inhalt im Worker) und grosse Inhalte der Cache API
// (als Dateien, nicht im Speicher). Nach einem Neustart: Inhalte und Preload noch
// da, das neue Skript kommt ohne register() (Hintergrund-Aktualisierung nach einer
// Navigation), WindowClient.navigate() laedt ein Fenster neu, registration.update()
// der Seite waehrend einer Hintergrund-Aktualisierung, navigate() auf ein
// gesperrtes Ziel und showNotification() mit notificationclick, das per
// clients.openWindow() einen Tab oeffnet bzw. mit WindowClient.focus() einen nach vorne holt.
//
//   cd tests/e2e && node serviceworker-test.mjs [engine-ordner]
import { SWIFTSHADER, TIMEOUT, canvasOrigin, check, collect, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

timeLimit();

const PAGE = `<!doctype html><title>SW-Test</title><body>Service Worker
<script>
const log = (text) => console.log('RESULT ' + text);
// SharedWorker: beide Objekte reden mit demselben Worker
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
  // Navigation Preload: der Stand bleibt nach einem Neustart
  const preload = (await navigator.serviceWorker.ready).navigationPreload;
  const before = await preload.getState();
  log('preloadbefore=' + before.enabled + ':' + before.headerValue);
  await preload.enable();
  await preload.setHeaderValue('bl-test');
  navigator.serviceWorker.controller.postMessage('ping');
})().catch((e) => log('error=' + e));
</script>`;

// Seite ohne register(): nur die Hintergrund-Aktualisierung bringt das neue Skript
const NOREG_PAGE = `<!doctype html><title>Ohne register</title><body><script>
const log = (text) => console.log('RESULT ' + text);
log('noreg=' + !!navigator.serviceWorker.controller);
navigator.serviceWorker.addEventListener('controllerchange', () => navigator.serviceWorker.controller.postMessage('version'));
navigator.serviceWorker.addEventListener('message', (e) => {
  log('update=' + e.data);
  navigator.serviceWorker.controller.postMessage('navigate');
});
</script>`;

const NAVIGATED_PAGE = `<!doctype html><title>Neu geladen</title><body><script>
navigator.serviceWorker.addEventListener('message', (e) => console.log('RESULT navresult=' + e.data));
console.log('RESULT navigated=' + !!navigator.serviceWorker.controller);
</script>`;

// Waehrend die Hintergrund-Aktualisierung auf das Skript wartet, ruft die Seite update()
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

// Cache API: drei Inhalte zu 16 MB, nach einem Neustart wieder gelesen
const CACHE_BIG_PAGE = `<!doctype html><title>Cache gross</title><body><script>
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

const CACHE_CHECK_PAGE = `<!doctype html><title>Cache lesen</title><body><script>
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

// Benachrichtigung aus showNotification(); der Klick auf den Knopf erlaubt sie
const NOTIFY_PAGE = `<!doctype html><title>Benachrichtigung</title><body style="margin:0">
<button id="allow" style="width:100%;height:400px">Erlauben</button><script>
const log = (text) => console.log('RESULT ' + text);
navigator.serviceWorker.addEventListener('message', (e) => log((e.data.startsWith('focus:') ? 'focus=' : 'notifymsg=') + e.data));
document.getElementById('allow').addEventListener('click', async () => {
  log('notifypermission=' + await Notification.requestPermission());
  const reg = await navigator.serviceWorker.ready;
  navigator.serviceWorker.controller.postMessage('open-without-click');
  await reg.showNotification('Hallo', { body: 'aus dem Test', tag: 't1' });
  log('notifylist=' + (await reg.getNotifications()).map((n) => n.title + ':' + n.tag).join(','));
  navigator.serviceWorker.controller.postMessage('focus-without-click');
  await reg.showNotification('Fokus', { tag: 'focus' });
});
log('notifyready=1');
</script>`;

const OPENED_PAGE = `<!doctype html><title>Geoeffnet</title><body><script>
navigator.serviceWorker.addEventListener('message', (e) => console.log('RESULT openedmsg=' + e.data));
console.log('RESULT opened=' + !!navigator.serviceWorker.controller);
</script>`;

// Kopf Service-Worker-Navigation-Preload pro Anfrage
const preloadRequests = { '/preload-use': [], '/preload-read': [] };
// Navigation Preload aus dem HTTP-Cache: frisch bzw. nachgeprueft (ETag, 304).
// Pro Anfrage Kopf und If-None-Match
const cachedPreloads = { '/preload-fresh': [], '/preload-etag': [] };

let swVersion = 1;
let swScriptFetches = 0;
let holdScript = false;
let scriptPending = false;
// Mit Umlauten und falschem charset: Worker-Skripte sind immer UTF-8, auch bei
// der Hintergrund-Aktualisierung
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
    e.respondWith(new Response('<title>Vom Worker</title><script>console.log("RESULT swpage=" + !!navigator.serviceWorker.controller)</script>', { headers: { 'Content-Type': 'text/html' } }));
  else if (url.pathname === '/preload-use')
    e.respondWith(e.preloadResponse);
  else if (url.pathname === '/preload-read')
    e.respondWith(e.preloadResponse.then((r) => r.text()).then((text) => new Response('<title>Preload</title><script>console.log("RESULT preloadread=" + ' + JSON.stringify(text) + ')</script>', { headers: { 'Content-Type': 'text/html' } })));
  else if (url.pathname.startsWith('/preload-') && e.request.mode === 'navigate')
    e.respondWith(e.preloadResponse);
});
// Klick auf eine Benachrichtigung aus showNotification(): neues Fenster, aber
// nie data: oder file: (Antwort an die Seite mit der Benachrichtigung)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // WindowClient.focus(): der Tab der Seite kommt nach vorne
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
    if (req.headers['service-worker'] === 'script')
      swScriptFetches++;
    const reply = () => res.writeHead(200, { 'Content-Type': 'text/javascript; charset=iso-8859-1' }).end(sw());
    if (!holdScript)
      return reply();
    holdScript = false;
    scriptPending = true;
    return setTimeout(() => { scriptPending = false; reply(); }, 3000);
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
    requests.push((req.headers['service-worker-navigation-preload'] || 'none') + ':' + (req.headers['if-none-match'] || 'none'));
    const etag = req.url === '/preload-etag';
    if (etag && req.headers['if-none-match'] === '"v1"')
      return res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'no-cache' }).end();
    const name = etag ? 'preloadetag' : 'preloadfresh';
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(etag ? { ETag: '"v1"', 'Cache-Control': 'no-cache' } : { 'Cache-Control': 'max-age=600' }) })
      .end(`<title>Preload</title><script>console.log('RESULT ${name}=${requests.length}')</script>`);
  }
  if (req.url in preloadRequests) {
    const header = req.headers['service-worker-navigation-preload'] || 'none';
    preloadRequests[req.url].push(header);
    if (req.url === '/preload-use')
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<title>Preload</title><script>console.log('RESULT preloaduse=${header}')</script>`);
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
// Benachrichtigungen des Host: headless gibt es keine, ein Ersatz merkt sie,
// damit der Test sie anklicken kann
await page.addInitScript(() => {
  window.__blNotifications = [];
  window.Notification = class extends EventTarget {
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, options = {}) {
      super();
      Object.assign(this, options, { title });
      window.__blNotifications.push(this);
    }
    close() { this.dispatchEvent(new Event('close')); }
  };
});
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms, () => results.has('error'));

// Nach einer Navigation prueft der Server das Skript (1 s spaeter). Erst wenn
// das durch ist, gibt es fuer die naechste Navigation eine eigene Pruefung,
// sonst legt WebKit die beiden zusammen.
async function softUpdateDone(fetchesBefore) {
  const end = Date.now() + 30000;
  while (swScriptFetches <= fetchesBefore && Date.now() < end)
    await page.waitForTimeout(100);
  await page.waitForTimeout(1000);
  return swScriptFetches > fetchesBefore;
}

const appURL = stack.app({ url: siteURL, debug: '1' });
await page.goto(appURL);
check('navigator.serviceWorker vorhanden', await result('registered') === '1' || results.get('sw') !== 'none', results.get('error') || '');
check('Registriert (ready)', await result('registered') === '1', results.get('error') || '');
check('Am Anfang ohne Worker', results.get('initialcontroller') === 'false', results.get('initialcontroller'));
check('Seite wird kontrolliert (clients.claim)', await result('controlled', 30000) === '1');
check('Fetch vom Worker beantwortet', await result('fetch', 30000) === 'from-sw', results.get('fetch'));
check('Antwort aus der Cache API des Workers', await result('cached', 30000) === 'cache-ok', results.get('cached'));
check('Antwort mit Blob', await result('blob', 30000) === 'blob-ok', results.get('blob'));
check('Nicht behandelt geht ins Netz', await result('network', 30000) === 'net', results.get('network'));
check('postMessage hin und zurueck', await result('message', 30000) === 'pong:ping', results.get('message'));

check('SharedWorker antwortet', await result('sharedA', 30000) === 'a:1', results.get('sharedA') || results.get('shared'));
check('Zweites SharedWorker-Objekt nutzt denselben Worker', await result('sharedB', 30000) === 'b:2', results.get('sharedB'));

// Navigation, die der Worker beantwortet (die Seite gibt es auf dem Server nicht)
await page.evaluate(() => window.__blEval('location.href = "/sw-page"'));
check('Navigation vom Worker beantwortet und kontrolliert', await result('swpage', 30000) === 'true', results.get('swpage'));
check('Navigation Preload am Anfang aus', results.get('preloadbefore') === 'false:true', results.get('preloadbefore'));

// Navigation Preload: die Antwort aus dem Netz (mit Kopf) als Seite und vom
// Worker gelesen, je nur eine Anfrage
await page.evaluate(() => window.__blEval('location.href = "/preload-use"'));
check('Navigation Preload: respondWith(preloadResponse)', await result('preloaduse', 30000) === 'bl-test', results.get('preloaduse'));
check('Navigation Preload: eine Anfrage', preloadRequests['/preload-use'].join() === 'bl-test', preloadRequests['/preload-use'].join());
await page.evaluate(() => window.__blEval('location.href = "/preload-read"'));
check('Navigation Preload: Worker liest den Inhalt', await result('preloadread', 30000) === 'preload-body:bl-test', results.get('preloadread'));
check('Navigation Preload: eine Anfrage beim Lesen', preloadRequests['/preload-read'].join() === 'bl-test', preloadRequests['/preload-read'].join());

// Navigation Preload ueber den HTTP-Cache: fetch() der Seite legt die Antwort
// in den Cache (asynchron, darum kurz warten), die Navigation danach nimmt sie
// frisch von dort bzw. prueft sie mit If-None-Match nach (304)
for (const [path, name, expected] of [['/preload-fresh', 'preloadfresh', 'none:none'], ['/preload-etag', 'preloadetag', 'none:none,bl-test:"v1"']]) {
  await page.evaluate((target) => window.__blEval(`fetch('${target}').then((r) => r.text()).then(() => setTimeout(() => { location.href = '${target}'; }, 1000))`), path);
  check(`Navigation Preload aus dem HTTP-Cache (${name})`, await result(name, 30000) === '1' && cachedPreloads[path].join() === expected, `${results.get(name)} ${cachedPreloads[path].join()}`);
}

// Cache API: grosse Inhalte liegen in Dateien, nicht im Speicher der Engine
async function engineMallocMB() {
  const line = page.waitForEvent('console', { predicate: (msg) => /malloc belegt \d+ MB/.test(msg.text()), timeout: 30000 });
  await page.evaluate(() => window.__blMemory(3));
  return Number(/malloc belegt (\d+) MB/.exec((await line).text())[1]);
}
// Dateien mit Inhalten der Cache API im OPFS der Oberflaeche (/data/cachestorage/*.bodies)
const bodyFiles = () => page.evaluate(async () => {
  let count = 0;
  const walk = async (directory, isBodies) => {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory')
        await walk(handle, name.endsWith('.bodies'));
      else if (isBodies)
        count++;
    }
  };
  await walk(await navigator.storage.getDirectory(), false);
  return count;
});
const mallocBefore = await engineMallocMB();
await page.evaluate(() => window.__blEval('location.href = "/cache-big"'));
check('Cache API: 48 MB gespeichert', await result('bigput', 60000) === 'ok', results.get('bigput'));
await page.waitForTimeout(1500);
const mallocAfter = await engineMallocMB();
check('Cache API: Inhalte nicht im Speicher', mallocAfter - mallocBefore < 24, `${mallocBefore} -> ${mallocAfter} MB`);
check('Cache API: Inhalte als Dateien', await bodyFiles() === 4, String(await bodyFiles()));

// Neustart des Browsers: die Registrierung kommt von der Platte (/data), die
// Seite ist von Anfang an kontrolliert
await page.waitForTimeout(7000);
results.clear();
const restartFetches = swScriptFetches;
await page.goto(appURL);
check('Nach Neustart: Seite gleich kontrolliert', await result('initialcontroller', 60000) === 'true', results.get('initialcontroller'));
check('Nach Neustart: Fetch vom Worker beantwortet', await result('fetch', 30000) === 'from-sw', results.get('fetch'));
check('Nach Neustart: Cache API des Workers noch da', await result('cached', 30000) === 'cache-ok', results.get('cached'));
check('Nach Neustart: Skript im Hintergrund geprueft', await softUpdateDone(restartFetches), `${swScriptFetches - restartFetches} Abrufe`);
check('Nach Neustart: Navigation Preload noch an', await result('preloadbefore', 30000) === 'true:bl-test', results.get('preloadbefore'));
const checkFetches = swScriptFetches;
await page.evaluate(() => window.__blEval('location.href = "/cache-check"'));
check('Nach Neustart: grosse Inhalte der Cache API gelesen', await result('bigcheck', 60000) === '16777216:65:65:48,16777216:66:66:49,16777216:67:67:50', results.get('bigcheck'));
check('Cache API: Cache geloescht', await result('bigdeleted', 30000) === 'true', results.get('bigdeleted'));
await page.waitForTimeout(1500);
check('Cache API: Dateien des geloeschten Cache weg', await bodyFiles() === 1, String(await bodyFiles()));
await softUpdateDone(checkFetches);

// Neues Skript auf dem Server, die Seite registriert nicht: nach der
// Navigation prueft der Server das Skript im Hintergrund, der neue Worker
// uebernimmt (skipWaiting, clients.claim)
swVersion = 2;
const fetchesBefore = swScriptFetches;
await page.evaluate(() => window.__blEval('location.href = "/noreg"'));
check('Seite ohne register() kontrolliert', await result('noreg', 30000) === 'true', results.get('noreg'));
check('Hintergrund-Aktualisierung: neues Skript aktiv (als UTF-8)', await result('update', 60000) === 'version:2:äöü', results.get('update'));
check('Hintergrund-Aktualisierung: Skript mit Service-Worker-Header geladen', swScriptFetches > fetchesBefore, `${swScriptFetches - fetchesBefore} Abrufe`);

// WindowClient.navigate(): der Worker laedt das Fenster neu und bekommt den neuen Client
check('WindowClient.navigate: neue Seite kontrolliert', await result('navigated', 30000) === 'true', results.get('navigate') || results.get('navigated'));
check('WindowClient.navigate: Client der neuen Seite', await result('navresult', 30000) === 'client:/navigated', results.get('navresult'));

// registration.update() der Seite, waehrend die Hintergrund-Aktualisierung nach
// der Navigation noch auf das Skript wartet: kommt danach dran
check('Nach WindowClient.navigate: Skript im Hintergrund geprueft', await softUpdateDone(fetchesBefore + 1));
holdScript = true;
await page.evaluate(() => window.__blEval('location.href = "/update"'));
check('update() der Seite waehrend Hintergrund-Aktualisierung erledigt', await result('pageupdate', 30000) === 'ok', results.get('pageupdate'));

// Gesperrter Port: das Laden endet, bevor eine Anfrage startet
check('WindowClient.navigate auf gesperrtes Ziel schlaegt fehl', await result('blocked', 30000) === 'TypeError', results.get('blocked'));

// Benachrichtigung aus showNotification(): ihr Klick geht als notificationclick
// an den Worker, der darf dann mit clients.openWindow() einen Tab oeffnen
const tabCount = () => page.locator('#tab-list .tab').count();
const tabsBefore = await tabCount();
await page.evaluate(() => window.__blEval('location.href = "/notify"'));
check('Seite fuer Benachrichtigungen geladen', await result('notifyready', 30000) === '1');
const origin = await canvasOrigin(page);
await page.mouse.click(origin.x + 200, origin.y + 100);
const prompt = page.locator('#permission-prompt:not([hidden])');
if (await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false))
  await prompt.locator('button', { hasText: 'Zulassen' }).click();
check('Benachrichtigungen erlaubt', await result('notifypermission', 15000) === 'granted', results.get('notifypermission'));
check('clients.openWindow ohne Klick abgelehnt', await result('notifymsg', 30000) === 'nowindow:InvalidAccessError', results.get('notifymsg'));
check('getNotifications findet sie', await result('notifylist', 30000) === 'Hallo:t1', results.get('notifylist'));
const shown = await page.waitForFunction(() => window.__blNotifications.some((n) => n.title === 'Hallo'), null, { timeout: 15000 }).then(() => true, () => false);
check('Benachrichtigung im Host gezeigt', shown);
results.delete('notifymsg');
await page.evaluate(() => window.__blNotifications.find((n) => n.title === 'Hallo').dispatchEvent(new Event('click')));
check('notificationclick: clients.openWindow oeffnet einen kontrollierten Tab', await result('opened', 30000) === 'true', results.get('opened'));
check('clients.openWindow gibt den Client des neuen Tabs', await result('openedmsg', 30000) === 'client:/opened:t1', results.get('openedmsg'));
check('clients.openWindow lehnt data: und file: ab', await result('notifymsg', 30000) === 'blocked:TypeError,TypeError', results.get('notifymsg'));
check('Neuer Tab in der Oberflaeche', await tabCount() === tabsBefore + 1, `${tabsBefore} -> ${await tabCount()}`);

// WindowClient.focus() nur nach notificationclick: holt den Tab der Seite nach vorne
const activeTitle = () => page.evaluate(() => document.querySelector('#tab-list .tab.active .title')?.textContent);
check('WindowClient.focus ohne Klick abgelehnt', await result('focus', 30000) === 'focus:InvalidAccessError', results.get('focus'));
results.delete('focus');
check('Vor WindowClient.focus: neuer Tab vorne', await activeTitle() === 'Geoeffnet', await activeTitle());
await page.evaluate(() => window.__blNotifications.find((n) => n.title === 'Fokus').dispatchEvent(new Event('click')));
const focused = await result('focus', 30000);
const front = await page.waitForFunction(() => document.querySelector('#tab-list .tab.active .title')?.textContent === 'Benachrichtigung', null, { timeout: 10000 }).then(() => true, () => false);
check('notificationclick: WindowClient.focus holt den Tab nach vorne', focused === 'focus:/notify' && front, `${focused}, ${await activeTitle()}`);

await browser.close();
finish();
