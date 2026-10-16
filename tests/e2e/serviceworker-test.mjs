// End-to-End Test fuer Service Worker und SharedWorker (engine/src/ServiceWorkerWasm.cpp):
// registrieren, Kontrolle per clients.claim(), Fetch abfangen (eigene Antwort,
// Cache API, Blob, nicht behandelt -> Netz), postMessage hin und zurueck und
// eine Navigation, die der Worker beantwortet. Nach einem Neustart: das neue
// Skript kommt ohne register() (Hintergrund-Aktualisierung nach einer
// Navigation), WindowClient.navigate() laedt ein Fenster neu, registration.update()
// der Seite waehrend einer Hintergrund-Aktualisierung und navigate() auf ein
// gesperrtes Ziel.
//
//   cd tests/e2e && node serviceworker-test.mjs [engine-ordner]
import { SWIFTSHADER, TIMEOUT, check, collect, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

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
});
self.addEventListener('message', (e) => {
  if (e.data === 'version')
    e.source.postMessage('version:' + VERSION + ':' + TEXT);
  else if (e.data === 'navigate')
    e.source.navigate('/navigated').then((client) => client.postMessage('client:' + new URL(client.url).pathname), (error) => console.log('RESULT navigate=' + error.name));
  else if (e.data === 'navigate-blocked')
    e.source.navigate('http://127.0.0.1:1/').then((client) => e.source.postMessage('resolved:' + client), (error) => e.source.postMessage(error.name));
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack({ token: 'serviceworker-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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

await browser.close();
finish();
