// End-to-End Test fuer WebAssembly der Seiten: die API in JSC reicht die
// Module an die WASM-Engine von Chromium weiter, der Speicher liegt im
// Speicher der Engine (engine/js/wasm-*.js, engine/src/wasm/).
//
//   cd tests/e2e && node wasm-test.mjs [engine-ordner]
//
// fixtures/ enthaelt ein kleines Modul (small.c) und ein Emscripten-Programm
// mit JS-Glue (program.cpp), neu bauen mit fixtures/build.sh.
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'wasm-token-0123456789abcdef';
const RELAY_PORT = 15701;
const UI_PORT = 15702;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);
// Ausgabe von program.cpp (in node mit dem Original gemessen)
const PROGRAM_RESULT = '3029871313';

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

const PAGE = `<!doctype html><title>WebAssembly-Test</title><body>WebAssembly<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const str = (t) => [t.length, ...new TextEncoder().encode(t)];
const sec = (id, ...items) => { const body = [items.length, ...items.flat()]; return [id, body.length, ...body]; };
const code = (...instr) => { const body = [0, ...instr, 11]; return [body.length, ...body]; };
// (i32)->i32 ruft env.add, (i64)->i64 Identitaet, ()->i32 liest env.g
const importsModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
  ...sec(1, [96, 1, 127, 1, 127], [96, 1, 126, 1, 126], [96, 0, 1, 127]),
  ...sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, 127, 0]),
  ...sec(3, [0], [1], [2]),
  ...sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  ...sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0))]);

(async () => {
  try {
    result('typeof', typeof WebAssembly + ',' + Object.keys(window).includes('WebAssembly') + ',' + Object.prototype.toString.call(WebAssembly));
    const bytes = await (await fetch('/small.wasm')).arrayBuffer();
    result('validate', WebAssembly.validate(bytes) + ',' + WebAssembly.validate(new Uint8Array([1, 2, 3])));
    const { module, instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    result('sum', ex.sum() + ',' + ex.simd_sum());
    // Speicher direkt aus JavaScript lesen und schreiben
    const ptr = ex.text_ptr();
    result('lesen', new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, 17)));
    new Uint8Array(ex.memory.buffer)[ptr] = 'W'.charCodeAt(0);
    result('schreiben', ex.copy(1) === 'W'.charCodeAt(0) + 'x'.charCodeAt(0));
    const oldBuffer = ex.memory.buffer;
    const old = ex.grow(2);
    result('grow', old + ',' + ex.size() + ',' + oldBuffer.byteLength + ',' + ex.memory.buffer.byteLength + ',' + ex.sum());
    result('poke', ex.poke(ex.size() - 1) + ',' + new Int32Array(ex.memory.buffer, (ex.size() - 1) * 65536 + 100, 1)[0]);
    try {
      ex.oob();
      result('trap', 'kein');
    } catch (e) {
      result('trap', (e instanceof WebAssembly.RuntimeError) + ',' + e.name);
    }
    result('atomic', ex.atomic());

    const calls = [];
    const m2 = await WebAssembly.compile(importsModule);
    result('imports', WebAssembly.Module.imports(m2).map((e) => e.module + '.' + e.name + ':' + e.kind).join('/'));
    const i2 = await WebAssembly.instantiate(m2, { env: { add: (x) => { calls.push(x); if (x === 13) throw new Error('aus JS'); return x + 1; }, g: 42 } });
    let thrown = '';
    try {
      i2.exports.call(13);
    } catch (e) {
      thrown = e.message;
    }
    result('aufrufe', i2.exports.call(5) + ',' + calls.join('/') + ',' + i2.exports.big(2n ** 40n) + ',' + i2.exports.read() + ',' + thrown);

    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    new Uint8Array(memory.buffer)[10] = 7;
    memory.grow(1);
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    table.set(0, i2.exports.call);
    const global = new WebAssembly.Global({ value: 'i64', mutable: true }, 5n);
    global.value = 9n;
    result('objekte', memory.buffer.byteLength + ',' + new Uint8Array(memory.buffer)[10] + ',' + (table.get(0) === i2.exports.call) + ',' + global.value);
    try {
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]));
    } catch (e) {
      result('compileerror', e instanceof WebAssembly.CompileError);
    }
    // Auch in einem Worker
    const workerCode = 'onmessage = async (e) => { try { const { instance } = await WebAssembly.instantiate(e.data, {}); '
      + 'postMessage(instance.exports.sum() + "," + new Uint8Array(instance.exports.memory.buffer, instance.exports.text_ptr(), 5).join(".")); '
      + '} catch (err) { postMessage("fehler " + err); } };';
    const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })));
    worker.onmessage = (e) => result('worker', e.data);
    worker.postMessage(bytes);
  } catch (e) {
    result('fehler', String(e && e.stack || e).replace(/\\s+/g, '_'));
  }
})();
</script>`;

const PROGRAM_PAGE = '<!doctype html><title>Emscripten</title><body>Emscripten<script src="/program.js"></script>';

const fixtures = path.join(here, 'fixtures');
const site = http.createServer((req, res) => {
  if (req.url === '/')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  if (req.url === '/program.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PROGRAM_PAGE);
  const file = path.join(fixtures, path.basename(req.url));
  if (/\.(wasm|js)$/.test(req.url) && fs.existsSync(file))
    return res.writeHead(200, { 'Content-Type': req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(fs.readFileSync(file));
  res.writeHead(404).end();
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
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(.*?)(?: \((?:https?|file):[^)]*\))?$/.exec(msg.text());
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
    if (results.has('fehler'))
      return 'fehler: ' + results.get('fehler');
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);

check('WebAssembly da, nicht aufzaehlbar', (await result('typeof')) === 'object,false,[object WebAssembly]', results.get('typeof'));
check('validate', (await result('validate')) === 'true,false', results.get('validate'));
check('Funktionen (auch SIMD)', (await result('sum')) === '80,80', results.get('sum'));
check('memory.buffer lesen', (await result('lesen')) === 'Hallo WebAssembly', results.get('lesen'));
check('memory.buffer schreiben', (await result('schreiben')) === 'true', results.get('schreiben'));
check('grow (alter Buffer abgehaengt)', (await result('grow')) === '2,4,0,262144,80', results.get('grow'));
check('neue Seite beschreiben', (await result('poke')) === '1234,1234', results.get('poke'));
check('Zugriff ausserhalb faengt', (await result('trap')) === 'true,RuntimeError', results.get('trap'));
check('Atomics', (await result('atomic')) === '42', results.get('atomic'));
check('Module.imports', (await result('imports')) === 'env.add:function/env.g:global', results.get('imports'));
check('Imports, i64, Ausnahme durch WASM', (await result('aufrufe')) === '6,13/5,1099511627776,42,aus JS', results.get('aufrufe'));
check('Memory, Table, Global', (await result('objekte')) === '131072,7,true,9', results.get('objekte'));
check('CompileError', (await result('compileerror')) === 'true', results.get('compileerror'));
check('WebAssembly im Worker', (await result('worker')) === '80,72.97.108.108.111', results.get('worker'));

// Emscripten-Programm mit JS-Glue (instantiateStreaming, Speicher waechst)
await page.fill('#address', siteURL + 'program.html');
await page.press('#address', 'Enter');
check('Emscripten-Programm', (await result('emscripten')) === PROGRAM_RESULT, results.get('emscripten'));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
