// End-to-End Test fuer den HTTP-Cache der Engine (engine/src/HttpCache.cpp):
// nach einem Neuladen der ganzen Oberflaeche (neue Engine, leerer
// Speicher-Cache) muessen frische Antworten aus dem Cache kommen, Antworten
// mit ETag werden nachgeprueft (304), no-store kommt immer vom Netz.
// Dazu der Bytecode-Cache (engine/src/BytecodeCache.cpp): ein grosses Skript
// kommt beim zweiten Besuch als fertiger Bytecode, ein geaendertes Skript
// unter gleicher URL darf den alten Bytecode nicht nehmen.
// Ausserdem: Header mit Umlaut sind aus dem Cache gleich wie vom Netz, eine
// Antwort, die nur mit der Verbindung endet, wird nicht gespeichert, und ueber der
// Grenze (hier mit kleiner Quote) fallen die aeltesten Eintraege weg.
//
//   cd tests/e2e && node cache-test.mjs [engine-ordner]
import { TIMEOUT, check, collect, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

timeLimit(2 * TIMEOUT + 120000);

const PAGE = `<!doctype html><title>Cache-Test</title><link rel=stylesheet href="/etag.css"><script src="/fresh.js"></script>
<body>Cache<script>
(async () => {
  const text = await (await fetch('/nostore.txt')).text();
  console.log('RESULT umlaut=' + (await fetch('/umlaut.txt')).headers.get('X-Umlaut'));
  console.log('RESULT visit=' + [window.freshValue, getComputedStyle(document.body).color.replace(/ /g, ''), text].join(','));
})();
</script>`;

// Grosses Skript (ueber der Mindestgroesse fuer den Bytecode-Cache) mit vielen
// Funktionen; ein Teil laeuft erst beim zweiten Besuch (Nachtrag im Cache)
let bigVersion = 1;
function bigScript() {
  let code = `var bigVersion = ${bigVersion};\n`;
  for (let i = 0; i < 120; i++)
    code += `function f${i}(x) { var s = 0; for (var k = 0; k < 10; k++) s += (x * ${i + 1} + k * bigVersion) % 97; return s + '${'abcdefgh'.repeat(2)}'.length; }\n`;
  code += `window.bigResult = function (all) { var t = 0; for (var i = 0; i < (all ? 120 : 60); i++) t += window['f' + i](i); return t; };\n`;
  return code;
}
const BC_PAGE = `<!doctype html><title>Bytecode</title><script src="/big.js"></script><body><script>
console.log('RESULT bc=' + bigVersion + ':' + bigResult(location.hash !== '#half'));
</script>`;

// Antwort ohne Laenge, die mit der Verbindung endet: beim ersten Mal haengt
// sie nach einem Teil, bis der Test das Relay neu startet
const CUT_PAGE = `<!doctype html><title>Abbruch</title><body><script>
fetch('/cut.txt').then((r) => r.text()).then((t) => console.log('RESULT cut=ok:' + t), () => console.log('RESULT cut=fehler'));
</script>`;
let cutStarted;
const cutRequest = new Promise((resolve) => cutStarted = resolve);

// Viele grosse cachebare Antworten (fuer das Aufraeumen)
const MANY_PAGE = `<!doctype html><title>Viele</title><body><script>
(async () => {
  for (let i = 1; i <= 8; i++)
    await (await fetch('/blob/' + i)).arrayBuffer();
  console.log('RESULT many=1');
})();
</script>`;

const requests = { fresh: 0, etag: 0, etag304: 0, nostore: 0, umlaut: 0, cut: 0 };
const { url: siteURL } = await serve((req, res) => {
  switch (req.url) {
  case '/':
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE);
  case '/fresh.js':
    requests.fresh++;
    return res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=3600' }).end("window.freshValue = 'frisch';");
  case '/etag.css':
    requests.etag++;
    if (req.headers['if-none-match'] === '"v1"') {
      requests.etag304++;
      return res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'no-cache' }).end();
    }
    return res.writeHead(200, { 'Content-Type': 'text/css', ETag: '"v1"', 'Cache-Control': 'no-cache' }).end('body { color: rgb(1, 2, 3); }');
  case '/bc':
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(BC_PAGE);
  case '/big.js':
    return res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(bigScript());
  case '/umlaut.txt':
    requests.umlaut++;
    return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600', 'X-Umlaut': 'grün' }).end('u');
  case '/cut':
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(CUT_PAGE);
  case '/cut.txt':
    if (++requests.cut > 1)
      return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' }).end('ganz');
    req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: max-age=3600\r\nConnection: close\r\n\r\nteil');
    cutStarted();
    return;
  case '/many':
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(MANY_PAGE);
  case '/nostore.txt':
    requests.nostore++;
    return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('netz' + requests.nostore);
  default:
    if (req.url.startsWith('/blob/'))
      return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'max-age=3600' }).end(Buffer.alloc(2 << 20, Number(req.url.slice(6))));
    return res.writeHead(404).end();
  }
});

const stack = await startStack({ token: 'cache-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
const result = (key) => results.wait(key);
// "zu spaet": die Antwort der Cache API kam erst nach dem Kompilieren (auf
// langsamen Runnern moeglich, die Seite laeuft dann ohne Cache richtig)
let bytecodeHits = 0;
let bytecodeLate = 0;
let bytecodeCommits = 0;
page.on('console', (msg) => {
  if (msg.text().includes('Bytecode-Cache: Treffer') && msg.text().includes('/big.js'))
    bytecodeHits++;
  if (msg.text().includes('Bytecode-Cache: zu spaet') && msg.text().includes('/big.js'))
    bytecodeLate++;
  // Statistik-Zeile nach jedem Speicher-Durchgang (engine/src/BytecodeCache.cpp)
  if (/Bytecode-Cache: \d+ Treffer/.test(msg.text()))
    bytecodeCommits++;
});

await page.goto(stack.app({ url: siteURL }));
const first = await result('visit');
check('Erster Besuch vom Netz', first === 'frisch,rgb(1,2,3),netz1', String(first));
const umlautFromNetwork = results.get('umlaut');
check('Je eine Anfrage', requests.fresh === 1 && requests.etag === 1 && requests.nostore === 1, JSON.stringify(requests));

// Speichern geht asynchron, kurz warten, dann die ganze Oberflaeche neu laden
await page.waitForTimeout(2000);
results.clear();
await page.reload();
const second = await result('visit');
check('Zweiter Besuch: Inhalte stimmen', second === 'frisch,rgb(1,2,3),netz2', String(second));
check('max-age: kam aus dem Cache (keine neue Anfrage)', requests.fresh === 1, JSON.stringify(requests));
check('ETag: nachgeprueft, 304', requests.etag === 2 && requests.etag304 === 1, JSON.stringify(requests));
check('no-store: wieder vom Netz', requests.nostore === 2, JSON.stringify(requests));
check('Header mit Umlaut: vom Netz', umlautFromNetwork === 'grün', umlautFromNetwork);
check('Header mit Umlaut: aus dem Cache gleich', results.get('umlaut') === 'grün' && requests.umlaut === 1, `${results.get('umlaut')} ${JSON.stringify(requests)}`);

// Antwort ohne Laenge, das Relay faellt mittendrin aus: WebCore nimmt das
// als Ende, darum kommen solche Antworten nie in den Cache (sonst kaeme beim
// naechsten Mal nur der Teil)
results.clear();
await page.goto(stack.app({ url: siteURL + 'cut' }));
await cutRequest;
await stack.restartRelay();
check('Abbruch durch das Relay beendet die Antwort', (await result('cut')) !== null, results.get('cut'));
results.clear();
await page.goto(stack.app({ url: siteURL + 'cut' }));
check('Abgebrochene Antwort nicht im Cache', (await result('cut')) === 'ok:ganz' && requests.cut === 2, `${results.get('cut')} ${requests.cut} Anfragen`);

// Bytecode-Cache: Erwartung mit dem gleichen Skript direkt in node rechnen
const expected = (version, all) => {
  let t = 0;
  for (let i = 0; i < (all ? 120 : 60); i++) {
    let s = 0;
    for (let k = 0; k < 10; k++) s += (i * (i + 1) + k * version) % 97;
    t += s + 16;
  }
  return `${version}:${t}`;
};
async function visitBytecode(hash) {
  results.clear();
  await page.goto(stack.app({ url: siteURL + 'bc' + hash, debug: '1' }));
  const commits = bytecodeCommits;
  const value = await result('bc');
  // Gespeichert wird 5 s nach dem Laden (dabei wird erst kodiert), dann
  // asynchron in die Cache API: auf die Statistik-Zeile warten, nicht fest
  const end = Date.now() + 40000;
  while (bytecodeCommits === commits && Date.now() < end)
    await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  return value;
}
const bc1 = await visitBytecode('#half');
check('Bytecode: erster Besuch', bc1 === expected(1, false), String(bc1));
check('Bytecode: erster Besuch ohne Treffer', bytecodeHits === 0, `Treffer=${bytecodeHits}`);
const bc2 = await visitBytecode('');
check('Bytecode: zweiter Besuch, auch neue Funktionen', bc2 === expected(1, true), String(bc2));
check('Bytecode: zweiter Besuch aus dem Cache', bytecodeHits + bytecodeLate === 1, `Treffer=${bytecodeHits} zu spaet=${bytecodeLate}`);
const bc3 = await visitBytecode('');
check('Bytecode: dritter Besuch (mit Nachtraegen)', bc3 === expected(1, true) && bytecodeHits + bytecodeLate === 2 && bytecodeHits >= 1,
  `${bc3} Treffer=${bytecodeHits} zu spaet=${bytecodeLate}`);
bigVersion = 2;
const bc4 = await visitBytecode('');
check('Bytecode: geaendertes Skript gleicher URL', bc4 === expected(2, true), String(bc4));
const bc5 = await visitBytecode('');
check('Bytecode: danach neuer Bytecode', bc5 === expected(2, true), String(bc5));

// Aufraeumen: mit 40 MB Quote ist die Grenze 10 MB, acht Antworten zu 2 MB
// passen nicht alle, die aeltesten fallen weg (eigene Groessen, x-bl-size)
const small = await browser.newContext();
const smallPage = await small.newPage();
const cdp = await small.newCDPSession(smallPage);
await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(stack.uiURL).origin, quotaSize: 40 << 20 });
const smallResults = collect(smallPage);
await smallPage.goto(stack.app({ url: siteURL + 'many' }));
check('Viele grosse Antworten geladen', (await smallResults.wait('many')) === '1');
const readCache = () => smallPage.evaluate(async () => {
  const cache = await caches.open('bl-http-v2');
  const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
  const total = (await cache.matchAll()).reduce((sum, response) => sum + Number(response.headers.get('x-bl-size')), 0);
  return { keys, total };
});
let stored = await readCache();
for (let i = 0; i < 100 && !(stored.keys.includes('/blob/8') && stored.total <= 10 << 20); i++) {
  await smallPage.waitForTimeout(200);
  stored = await readCache();
}
check('Aufraeumen: unter der Grenze, neuester Eintrag da, aeltester weg',
  stored.total <= 10 << 20 && stored.keys.includes('/blob/8') && !stored.keys.includes('/blob/1'), JSON.stringify(stored));

await browser.close();
finish();
