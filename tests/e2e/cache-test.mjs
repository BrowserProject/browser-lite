// End-to-End Test fuer den HTTP-Cache der Engine (engine/src/HttpCache.cpp):
// nach einem Neuladen der ganzen Oberflaeche (neue Engine, leerer
// Speicher-Cache) muessen frische Antworten aus dem Cache kommen, Antworten
// mit ETag werden nachgeprueft (304), no-store kommt immer vom Netz.
// Dazu der Bytecode-Cache (engine/src/BytecodeCache.cpp): ein grosses Skript
// kommt beim zweiten Besuch als fertiger Bytecode, ein geaendertes Skript
// unter gleicher URL darf den alten Bytecode nicht nehmen.
//
//   cd tests/e2e && node cache-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'cache-token-0123456789abcdef';
const RELAY_PORT = 15801;
const UI_PORT = 15802;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, 2 * TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

const PAGE = `<!doctype html><title>Cache-Test</title><link rel=stylesheet href="/etag.css"><script src="/fresh.js"></script>
<body>Cache<script>
(async () => {
  const text = await (await fetch('/nostore.txt')).text();
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

const requests = { fresh: 0, etag: 0, etag304: 0, nostore: 0 };
const site = http.createServer((req, res) => {
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
  case '/nostore.txt':
    requests.nostore++;
    return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('netz' + requests.nostore);
  default:
    return res.writeHead(404).end();
  }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}
const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
let results = new Map();
let bytecodeHits = 0;
page.on('console', (msg) => {
  if (msg.text().includes('Bytecode-Cache: Treffer') && msg.text().includes('/big.js'))
    bytecodeHits++;
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  else if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
async function result(key) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
const first = await result('visit');
check('Erster Besuch vom Netz', first === 'frisch,rgb(1,2,3),netz1', String(first));
check('Je eine Anfrage', requests.fresh === 1 && requests.etag === 1 && requests.nostore === 1, JSON.stringify(requests));

// Speichern geht asynchron, kurz warten, dann die ganze Oberflaeche neu laden
await page.waitForTimeout(2000);
results = new Map();
await page.reload();
const second = await result('visit');
check('Zweiter Besuch: Inhalte stimmen', second === 'frisch,rgb(1,2,3),netz2', String(second));
check('max-age: kam aus dem Cache (keine neue Anfrage)', requests.fresh === 1, JSON.stringify(requests));
check('ETag: nachgeprueft, 304', requests.etag === 2 && requests.etag304 === 1, JSON.stringify(requests));
check('no-store: wieder vom Netz', requests.nostore === 2, JSON.stringify(requests));

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
  results = new Map();
  const bcQuery = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL + 'bc' + hash, debug: '1' });
  await page.goto(`http://localhost:${UI_PORT}/?${bcQuery}`);
  const value = await result('bc');
  // Speichern laeuft 5 s nach dem Laden, dann asynchron in die Cache API
  await page.waitForTimeout(7000);
  return value;
}
const bc1 = await visitBytecode('#half');
check('Bytecode: erster Besuch', bc1 === expected(1, false), String(bc1));
check('Bytecode: erster Besuch ohne Treffer', bytecodeHits === 0, `Treffer=${bytecodeHits}`);
const bc2 = await visitBytecode('');
check('Bytecode: zweiter Besuch, auch neue Funktionen', bc2 === expected(1, true), String(bc2));
check('Bytecode: zweiter Besuch aus dem Cache', bytecodeHits === 1, `Treffer=${bytecodeHits}`);
const bc3 = await visitBytecode('');
check('Bytecode: dritter Besuch (mit Nachtraegen)', bc3 === expected(1, true) && bytecodeHits === 2, `${bc3} Treffer=${bytecodeHits}`);
bigVersion = 2;
const bc4 = await visitBytecode('');
check('Bytecode: geaendertes Skript gleicher URL', bc4 === expected(2, true), String(bc4));
const bc5 = await visitBytecode('');
check('Bytecode: danach neuer Bytecode', bc5 === expected(2, true), String(bc5));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
