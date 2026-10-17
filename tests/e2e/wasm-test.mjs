// End-to-End Test fuer WebAssembly der Seiten: die API in JSC reicht die
// Module an die WASM-Engine von Chromium weiter, der Speicher liegt im
// Speicher der Engine (engine/js/wasm-*.js, engine/src/wasm/).
//
//   cd tests/e2e && node wasm-test.mjs [engine-ordner]
//
// fixtures/ enthaelt ein kleines Modul (small.c) und ein Emscripten-Programm
// mit JS-Glue (program.cpp, auch als memory64-Variante program64), neu bauen
// mit fixtures/build.sh. Weitere Module von Hand (tests/wasm/wasm-bytes.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY64_RESULT, MULTI_MEMORY_RESULT, source as wasmBytes } from '../wasm/wasm-bytes.mjs';
import { TIMEOUT, check, collect, finish, here, launch, serve, startStack, timeLimit } from './harness.mjs';

// Ausgabe von program.cpp (in node mit dem Original gemessen)
const PROGRAM_RESULT = '3029871313';
timeLimit();

const PAGE = `<!doctype html><title>WebAssembly-Test</title><body>WebAssembly<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const errorName = (fn) => { try { fn(); return 'kein'; } catch (e) { return e.name; } };
${wasmBytes}
// (i32)->i32 ruft env.add, (i64)->i64 Identitaet, ()->i32 liest env.g
const importsModule = wasm(
  sec(1, [96, 1, 127, 1, 127], [96, 1, 126, 1, 126], [96, 0, 1, 127]),
  sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, 127, 0]),
  sec(3, [0], [1], [2]),
  sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0)));
// wait32 auf nicht geteiltem Speicher, Tabelle mit Init-Ausdruck (ref.func 1)
const trapsModule = wasm(
  sec(1, [96, 0, 1, 127]),
  sec(3, [0], [0], [0], [0]),
  sec(4, [0x40, 0, 0x70, 0, 1, 0xd2, 1, 11]),
  sec(5, [0, 1]),
  sec(7, [...str('wait'), 0, 0], [...str('table'), 0, 3]),
  sec(10, code(65, 0, 65, 0, 66, 0, 0xfe, 1, 2, 0), code(65, 42), code(65, 7), code(65, 0, 0x11, 0, 0)));
// (i32)->i32: ruft env.down (Rekursion ueber JS)
const recursionModule = wasm(
  sec(1, [96, 1, 127, 1, 127]),
  sec(2, [...str('env'), ...str('down'), 0, 0]),
  sec(3, [0]),
  sec(7, [...str('down'), 0, 1]),
  sec(10, code(32, 0, 16, 0)));
// table64 ohne Speicher: Tabelle "t" (i64, 2 Eintraege, t[0] gibt 42),
// call(i64) ruft t[i] auf
const table64Module = wasm(
  sec(1, [96, 0, 1, 127], [96, 1, 126, 1, 127]),
  sec(3, [0], [1]),
  sec(4, [0x70, 0x04, 2]),
  sec(7, [...str('t'), 1, 0], [...str('call'), 0, 1]),
  sec(9, [0, 66, 0, 11, 1, 0]),
  sec(10, code(65, 42), code(32, 0, 0x11, 0, 0)));
const symbols = () => Object.getOwnPropertySymbols(globalThis).length;
const symbolsBefore = symbols();

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
    result('symbole', symbolsBefore + ',' + symbols());
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

    // memory.buffer ist nicht abloesbar, bleibt aber abgehaengt nach grow
    const fixed = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    new Uint8Array(fixed.buffer)[10] = 7;
    const before = fixed.buffer;
    const transfer = errorName(() => fixed.buffer.transfer()) + ',' + errorName(() => structuredClone(fixed.buffer, { transfer: [fixed.buffer] }));
    const copy = structuredClone(fixed.buffer);
    fixed.grow(1);
    result('abloesen', transfer + ',' + copy.byteLength + ',' + new Uint8Array(fixed.buffer)[10] + ',' + before.byteLength + ',' + fixed.buffer.byteLength);
    result('grenze', errorName(() => new WebAssembly.Memory({ initial: 65536 })) + ',' + errorName(() => new WebAssembly.Memory({ initial: 1, maximum: 65536 }).grow(40000)));
    result('features', WebAssembly.validate(wasm(sec(5, [3, 1, 1]))) + ',' + WebAssembly.validate(wasm(sec(5, [0, 1], [0, 1]))));
    // Mehrere Speicher, memory64 und table64
    const textAt = (memory, at, length) => new TextDecoder().decode(new Uint8Array(memory.buffer, at, length));
    const multi = (await WebAssembly.instantiate(multiMemoryModule())).instance.exports;
    result('mehrspeicher', multiMemoryRun(multi));
    result('mehrspeicher_objekte', textAt(multi.m0, 0, 4) + textAt(multi.m1, 16, 4) + textAt(multi.m2, 0, 3) + ',' + (multi.m1 !== multi.m0) + ',' + multi.m1.buffer.byteLength);
    const m64 = (await WebAssembly.instantiate(memory64Module())).instance.exports;
    result('memory64', memory64Run(m64));
    new BigUint64Array(m64.memory.buffer)[50] = 77n;
    result('memory64_js', textAt(m64.memory, 8, 5) + ',' + m64.load(400n) + ',' + m64.memory.grow(1n) + ',' + m64.size() + ',' + m64.memory.buffer.byteLength
      + ',' + errorName(() => m64.memory.grow(1)) + ',' + new WebAssembly.Memory({ address: 'i64', initial: 1n }).grow(2n));
    const t64 = (await WebAssembly.instantiate(table64Module)).instance.exports;
    const before64 = t64.t.length + ',' + t64.call(0n) + ',' + errorName(() => t64.call(1n)) + ',' + errorName(() => t64.t.get(0));
    t64.t.set(1n, t64.t.get(0n));
    result('table64', before64 + ',' + t64.call(1n) + ',' + t64.t.grow(1n) + ',' + t64.t.length + ',' + new WebAssembly.Table({ address: 'i64', element: 'anyfunc', initial: 1n }).length);
    const traps = (await WebAssembly.instantiate(trapsModule)).instance.exports;
    const refs = new WebAssembly.Table({ element: 'externref', initial: 1 });
    refs.set(0, fixed);
    result('umschreiben', errorName(() => traps.wait()) + ',' + traps.table() + ',' + (refs.get(0) === fixed));
    let down;
    down = new WebAssembly.Instance(new WebAssembly.Module(recursionModule), { env: { down: (n) => (n > 0 ? down(n - 1) + 1 : 0) } }).exports.down;
    // Grenze 64 Ebenen (WasmBridge.cpp), weit unter dem Ueberlauf im Browser
    result('rekursion', errorName(() => down(100)) + ',' + down(50) + ',' + errorName(() => down(100000)) + ',' + ex.sum());
    // Auch in einem Worker
    const workerCode = 'onmessage = async (e) => { try { const { instance } = await WebAssembly.instantiate(e.data, {}); '
      + 'postMessage(instance.exports.sum() + "," + new Uint8Array(instance.exports.memory.buffer, instance.exports.text_ptr(), 5).join(".")); '
      + '} catch (err) { postMessage("fehler " + err); } };';
    // Zweimal: nach dem Ende des ersten Workers (Realm abgebaut) laeuft ein neuer
    const workerURL = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
    const runWorker = () => new Promise((resolve) => {
      const worker = new Worker(workerURL);
      worker.onmessage = (e) => {
        worker.terminate();
        resolve(e.data);
      };
      worker.postMessage(bytes);
    });
    const first = await runWorker();
    await new Promise((resolve) => setTimeout(resolve, 500));
    result('worker', first + '/' + await runWorker());
  } catch (e) {
    result('fehler', String(e && e.stack || e).replace(/\\s+/g, '_'));
  }
})();
</script>`;

const PROGRAM_PAGE = (name) => `<!doctype html><title>Emscripten</title><body>Emscripten<script src="/${name}.js"></script>`;

// Seite mit 64 MB Speicher und einem Zyklus ueber beide Seiten wie bei
// Emscripten-Glue: der Import ruft Exporte der eigenen Instanz
const LEAK_PAGES = 1024;
const LEAK_PAGE = `<!doctype html><title>Zyklus</title><body>Zyklus<script>
${wasmBytes}
const leakModule = wasm(
  sec(1, [96, 0, 1, 127]),
  sec(2, [...str('env'), ...str('f'), 0, 0]),
  sec(3, [0], [0]),
  sec(5, [0, ...leb(${LEAK_PAGES})]),
  sec(7, [...str('memory'), 2, 0], [...str('g'), 0, 1], [...str('callF'), 0, 2]),
  sec(10, code(65, 0, 45, 0, 0), code(16, 0)));
(async () => {
  let ex;
  const { instance } = await WebAssembly.instantiate(leakModule, { env: { f: () => ex.g() } });
  ex = instance.exports;
  new Uint8Array(ex.memory.buffer)[0] = 5;
  console.log('RESULT ' + new URLSearchParams(location.search).get('key') + '=' + ex.callF());
})();
</script>`;

// Langlebiger Worker, pro Auftrag eine neue Instanz mit 16 MB und einem
// Import aus JS. Der Worker-Thread muss dazwischen in den Event-Loop des Host
// zurueck, sonst feuert dort keine FinalizationRegistry (Speicher und Werte aus
// JS blieben bis zum Ende des Workers).
const JOB_PAGES = 256;
const JOBS_WORKER = `${wasmBytes}
const jobModule = wasm(
  sec(1, [96, 0, 1, 127]),
  sec(2, [...str('env'), ...str('f'), 0, 0]),
  sec(3, [0], [0]),
  sec(5, [0, ...leb(${JOB_PAGES})]),
  sec(7, [...str('memory'), 2, 0], [...str('g'), 0, 1], [...str('callF'), 0, 2]),
  sec(10, code(65, 0, 45, 0, 0), code(16, 0)));
let finalized = false;
const registry = new FinalizationRegistry(() => { finalized = true; });
registry.register({}, 0);
onmessage = async ({ data: n }) => {
  const ex = (await WebAssembly.instantiate(jobModule, { env: { f: () => n } })).instance.exports;
  new Uint8Array(ex.memory.buffer)[0] = n % 100;
  // Etwas Muell, damit JSC sammelt
  for (let i = 0; i < 20000; i++) new Array(8);
  postMessage([n, ex.callF() + '.' + ex.g() + ',' + finalized]);
};`;
const JOBS_PAGE = `<!doctype html><title>Auftraege</title><body>Auftraege<script>
const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(JOBS_WORKER)}], { type: 'text/javascript' })));
worker.onmessage = ({ data: [n, value] }) => console.log('RESULT job' + n + '=' + value);
window.job = (n) => worker.postMessage(n);
console.log('RESULT jobs=bereit');
</script>`;

// Zwei iframes verschiedener Herkunft im selben Thread der Engine: das zweite
// raet die ids von Speichern und verbiegt WeakMap, damit die API sie benutzt.
// Nur die eigene id darf gehen (Pruefung in WasmBridge.cpp und wasm-host.js).
const REALMS_PAGE = (victimURL) => `<!doctype html><title>Realms</title><body>Realms<script>
const frame = (src) => document.body.appendChild(Object.assign(document.createElement('iframe'), { src }));
const victim = frame('${victimURL}');
onmessage = ({ data: [key, value] }) => {
  if (key === 'bereit')
    frame('/attacker.html');
  if (key === 'angriff')
    victim.contentWindow.postMessage(['pruefen'], '*');
  if (key !== 'bereit')
    console.log('RESULT ' + key + '=' + value);
};
</script>`;
const VICTIM_PAGE = `<!doctype html><title>Opfer</title><body>Opfer<script>
const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
new Uint8Array(memory.buffer).set(new TextEncoder().encode('GEHEIM'));
onmessage = () => parent.postMessage(['opfer', new TextDecoder().decode(new Uint8Array(memory.buffer, 0, 6)) + ',' + memory.buffer.byteLength], '*');
parent.postMessage(['bereit'], '*');
</script>`;
const ATTACKER_PAGE = `<!doctype html><title>Angriff</title><body>Angriff<script>
${wasmBytes}
const { get, has, set } = WeakMap.prototype;
let ownId, forgedId;
WeakMap.prototype.set = function (key, value) {
  if (value && value.kind === 'memory')
    ownId = value.memoryId;
  return set.call(this, key, value);
};
const own = new WebAssembly.Memory({ initial: 1 });
WeakMap.prototype.set = set;
const fake = {};
WeakMap.prototype.get = function (key) { return key === fake ? { kind: 'memory', memoryId: forgedId, address: 'i32' } : get.call(this, key); };
WeakMap.prototype.has = function (key) { return key === fake || has.call(this, key); };
const works = (fn) => { try { fn(); return true; } catch (e) { return false; } };
const buffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get;
// ()->i32: liest das erste Wort des importierten Speichers
const memoryImport = new WebAssembly.Module(wasm(
  sec(1, [96, 0, 1, 127]),
  sec(2, [...str('env'), ...str('memory'), 2, 0, 1]),
  sec(3, [0]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(65, 0, 40, 2, 0))));
const attempts = () => [
  works(() => buffer.call(fake).byteLength),
  works(() => WebAssembly.Memory.prototype.grow.call(fake, 1)),
  works(() => new WebAssembly.Instance(memoryImport, { env: { memory: fake } }).exports.f()),
];
forgedId = ownId;
const control = attempts().every(Boolean);
const hits = [0, 0, 0];
for (forgedId = 1; forgedId < ownId; forgedId++)
  attempts().forEach((ok, i) => { hits[i] += ok ? 1 : 0; });
Object.assign(WeakMap.prototype, { get, has });
parent.postMessage(['angriff', control + ',' + hits.join(',') + ',' + (ownId > 1)], '*');
</script>`;

const fixtures = path.join(here, 'fixtures');
const { url: victimURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(VICTIM_PAGE));
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  if (req.url === '/program.html' || req.url === '/program64.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PROGRAM_PAGE(req.url.slice(1, -5)));
  if (req.url === '/realms.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(REALMS_PAGE(victimURL));
  if (req.url === '/attacker.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ATTACKER_PAGE);
  if (req.url.startsWith('/leak.html'))
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LEAK_PAGE);
  if (req.url === '/jobs.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(JOBS_PAGE);
  if (req.url === '/grow.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Wachsen</title><body>Wachsen<script>console.log("RESULT wachsen=bereit")</script>');
  const file = path.join(fixtures, path.basename(req.url));
  if (/\.(wasm|js)$/.test(req.url) && fs.existsSync(file))
    return res.writeHead(200, { 'Content-Type': req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(fs.readFileSync(file));
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'wasm-token-0123456789abcdef' });
// gc() in den Web Workern der Engine (Host-Seite der Bruecke)
const browser = await launch({ args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(?: \((?:https?|file):[^)]*\))?$/);
async function result(key) {
  const value = await results.wait(key, TIMEOUT, () => results.has('fehler'));
  return value ?? (results.has('fehler') ? 'fehler: ' + results.get('fehler') : null);
}

await page.goto(stack.app({ url: siteURL }));

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
check('Bruecke ohne sichtbares Symbol', /^(\d+),\1$/.test(await result('symbole')), results.get('symbole'));
check('Imports, i64, Ausnahme durch WASM', (await result('aufrufe')) === '6,13/5,1099511627776,42,aus JS', results.get('aufrufe'));
check('Memory, Table, Global', (await result('objekte')) === '131072,7,true,9', results.get('objekte'));
check('CompileError', (await result('compileerror')) === 'true', results.get('compileerror'));
check('memory.buffer nicht abloesbar', (await result('abloesen')) === 'TypeError,TypeError,65536,7,0,131072', results.get('abloesen'));
check('Speicher-Grenze', (await result('grenze')) === 'RangeError,RangeError', results.get('grenze'));
check('validate: ohne Threads, mit mehreren Speichern', (await result('features')) === 'false,true', results.get('features'));
check('Mehrere Speicher', (await result('mehrspeicher')) === MULTI_MEMORY_RESULT, results.get('mehrspeicher'));
check('Mehrere Speicher als Memory-Objekte', (await result('mehrspeicher_objekte')) === 'ZweiZweiDre,true,131072', results.get('mehrspeicher_objekte'));
check('memory64', (await result('memory64')) === MEMORY64_RESULT, results.get('memory64'));
check('memory64: buffer und grow mit BigInt', (await result('memory64_js')) === 'Hallo,77,3,4,262144,TypeError,1', results.get('memory64_js'));
check('table64', (await result('table64')) === '2,42,RuntimeError,TypeError,42,2,3,1', results.get('table64'));
check('wait faengt, Tabelle mit Init, Memory als externref', (await result('umschreiben')) === 'RuntimeError,42,true', results.get('umschreiben'));
check('Rekursion JS <-> WASM zu tief', (await result('rekursion')) === 'RangeError,50,RangeError,80', results.get('rekursion'));
check('WebAssembly im Worker, zweiter Worker danach', (await result('worker')) === '80,72.97.108.108.111/80,72.97.108.108.111', results.get('worker'));

// Emscripten-Programm mit JS-Glue (instantiateStreaming, Speicher waechst)
await page.fill('#address', siteURL + 'program.html');
await page.press('#address', 'Enter');
check('Emscripten-Programm', (await result('emscripten')) === PROGRAM_RESULT, results.get('emscripten'));

// Dasselbe Programm mit -sMEMORY64 (i64-Speicher und table64)
results.delete('emscripten');
await page.fill('#address', siteURL + 'program64.html');
await page.press('#address', 'Enter');
check('Emscripten-Programm mit memory64', (await result('emscripten')) === PROGRAM_RESULT, results.get('emscripten'));

// Speicher einer anderen Herkunft: kein buffer, grow oder Import mit seiner id
await page.fill('#address', siteURL + 'realms.html');
await page.press('#address', 'Enter');
check('Fremder Speicher mit geratener id gesperrt', (await result('angriff')) === 'true,0,0,0,true', results.get('angriff'));
check('Speicher der anderen Herkunft unveraendert', (await result('opfer')) === 'GEHEIM,65536', results.get('opfer'));

// Belegter Speicher der Engine in MB (malloc)
const usedMB = () => page.evaluate(() => window.__blEngine()._bl_memory_used() / 2 ** 20);
const run = (source) => page.evaluate((source) => window.__blEval(source), source);

// Auftraege im Worker: Speicher und Werte frueherer Instanzen werden frei.
// gc() der Host-Seite in allen Workern der Engine, die gerade antworten.
async function hostGC() {
  await Promise.all(page.workers().map((worker) => Promise.race([
    worker.evaluate(() => globalThis.gc && gc()).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 200)),
  ])));
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await page.fill('#address', siteURL + 'jobs.html');
await page.press('#address', 'Enter');
await result('jobs');
async function runJobs(from, to) {
  let last = null;
  for (let n = from; n < to; n++) {
    await run(`job(${n})`);
    last = await result('job' + n);
    await hostGC();
  }
  return last;
}
await runJobs(0, 4);
const beforeJobs = await usedMB();
const lastJob = await runJobs(4, 24);
const jobsGrown = await usedMB() - beforeJobs;
check('Worker: Speicher frueherer Instanzen frei', lastJob === '23.23,true' && jobsGrown < 6 * JOB_PAGES / 16,
  `${lastJob}, ${jobsGrown.toFixed(0)} MB mehr nach 20 Auftraegen zu ${JOB_PAGES / 16} MB`);

// Wachsen wie im Standard um genau die Seiten, mit begrenzter Reserve: 128 MB
// um 1 MB belegen ein Viertel Reserve dazu, nicht das Doppelte
await page.fill('#address', siteURL + 'grow.html');
await page.press('#address', 'Enter');
await result('wachsen');
await run('window.grown = new WebAssembly.Memory({ initial: 2048 }); console.log("RESULT angelegt=1")');
await result('angelegt');
const beforeGrow = await usedMB();
await run('grown.grow(16); console.log("RESULT gewachsen=" + grown.buffer.byteLength / 2 ** 20)');
const grownSize = Number(await result('gewachsen'));
const grownUsed = await usedMB() - beforeGrow;
check('memory.grow mit begrenzter Reserve', grownSize === 129 && grownUsed < 48, `${grownUsed.toFixed(0)} MB mehr fuer 128 -> ${grownSize} MB`);

// Viele Seiten mit Zyklus und 64 MB: der Speicher wird mit der Seite frei
const engineBytes = () => page.evaluate(() => window.__blMemory());
async function visitLeakPages(from, to) {
  for (let i = from; i < to; i++) {
    await page.fill('#address', siteURL + 'leak.html?key=leak' + i);
    await page.press('#address', 'Enter');
    if ((await result('leak' + i)) !== '5')
      return false;
  }
  return true;
}
const warm = await visitLeakPages(0, 4);
const start = await engineBytes();
const visited = warm && await visitLeakPages(4, 24);
const grown = (await engineBytes() - start) / 2 ** 20;
check('Speicher alter Seiten frei', visited && grown < 8 * LEAK_PAGES / 16, `${grown} MB mehr nach 20 Seiten zu ${LEAK_PAGES / 16} MB`);

await browser.close();
finish();
