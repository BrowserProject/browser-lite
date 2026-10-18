// WebAssembly of the pages: the API in JSC hands the modules to the WASM engine of Chromium, the
// memory lives in the memory of the engine (engine/js/wasm-*.js, engine/src/wasm/).
//
//   node tests/core/wasm-test.mjs [engine-dir]
//
// tests/fixtures/wasm/ has a small module (small.c) and an Emscripten program with JS glue
// (program.cpp, also as the memory64 variant program64), rebuilt with fixtures/wasm/build.sh.
// More hand written modules: tests/fixtures/wasm-bytes.mjs.
import fs from 'node:fs';
import path from 'node:path';
import {
  MEMORY64_RESULT,
  MULTI_MEMORY_RESULT,
  source as wasmBytes,
} from '../fixtures/wasm-bytes.mjs';
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  root,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

// Output of program.cpp (measured in node with the original)
const PROGRAM_RESULT = '3029871313';
timeLimit();

const PAGE = `<!doctype html><title>WebAssembly test</title><body>WebAssembly<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const errorName = (fn) => { try { fn(); return 'none'; } catch (e) { return e.name; } };
${wasmBytes}
// (i32)->i32 calls env.add, (i64)->i64 identity, ()->i32 reads env.g
const importsModule = wasm(
  sec(1, [96, 1, 127, 1, 127], [96, 1, 126, 1, 126], [96, 0, 1, 127]),
  sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, 127, 0]),
  sec(3, [0], [1], [2]),
  sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0)));
// wait32 on unshared memory, a table with an init expression (ref.func 1)
const trapsModule = wasm(
  sec(1, [96, 0, 1, 127]),
  sec(3, [0], [0], [0], [0]),
  sec(4, [0x40, 0, 0x70, 0, 1, 0xd2, 1, 11]),
  sec(5, [0, 1]),
  sec(7, [...str('wait'), 0, 0], [...str('table'), 0, 3]),
  sec(10, code(65, 0, 65, 0, 66, 0, 0xfe, 1, 2, 0), code(65, 42), code(65, 7), code(65, 0, 0x11, 0, 0)));
// (i32)->i32: calls env.down (recursion through JS)
const recursionModule = wasm(
  sec(1, [96, 1, 127, 1, 127]),
  sec(2, [...str('env'), ...str('down'), 0, 0]),
  sec(3, [0]),
  sec(7, [...str('down'), 0, 1]),
  sec(10, code(32, 0, 16, 0)));
// table64 without memory: table "t" (i64, 2 entries, t[0] returns 42), call(i64) calls t[i]
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
    // Read and write the memory directly from JavaScript
    const ptr = ex.text_ptr();
    result('read', new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, 17)));
    new Uint8Array(ex.memory.buffer)[ptr] = 'W'.charCodeAt(0);
    result('write', ex.copy(1) === 'W'.charCodeAt(0) + 'x'.charCodeAt(0));
    const oldBuffer = ex.memory.buffer;
    const old = ex.grow(2);
    result('grow', old + ',' + ex.size() + ',' + oldBuffer.byteLength + ',' + ex.memory.buffer.byteLength + ',' + ex.sum());
    result('poke', ex.poke(ex.size() - 1) + ',' + new Int32Array(ex.memory.buffer, (ex.size() - 1) * 65536 + 100, 1)[0]);
    try {
      ex.oob();
      result('trap', 'none');
    } catch (e) {
      result('trap', (e instanceof WebAssembly.RuntimeError) + ',' + e.name);
    }
    result('atomic', ex.atomic());

    const calls = [];
    const m2 = await WebAssembly.compile(importsModule);
    result('imports', WebAssembly.Module.imports(m2).map((e) => e.module + '.' + e.name + ':' + e.kind).join('/'));
    const i2 = await WebAssembly.instantiate(m2, { env: { add: (x) => { calls.push(x); if (x === 13) throw new Error('from JS'); return x + 1; }, g: 42 } });
    let thrown = '';
    try {
      i2.exports.call(13);
    } catch (e) {
      thrown = e.message;
    }
    result('symbols', symbolsBefore + ',' + symbols());
    result('calls', i2.exports.call(5) + ',' + calls.join('/') + ',' + i2.exports.big(2n ** 40n) + ',' + i2.exports.read() + ',' + thrown);

    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    new Uint8Array(memory.buffer)[10] = 7;
    memory.grow(1);
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    table.set(0, i2.exports.call);
    const global = new WebAssembly.Global({ value: 'i64', mutable: true }, 5n);
    global.value = 9n;
    result('objects', memory.buffer.byteLength + ',' + new Uint8Array(memory.buffer)[10] + ',' + (table.get(0) === i2.exports.call) + ',' + global.value);
    try {
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]));
    } catch (e) {
      result('compileerror', e instanceof WebAssembly.CompileError);
    }

    // memory.buffer is not detachable, but stays detached after grow
    const fixed = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    new Uint8Array(fixed.buffer)[10] = 7;
    const before = fixed.buffer;
    const transfer = errorName(() => fixed.buffer.transfer()) + ',' + errorName(() => structuredClone(fixed.buffer, { transfer: [fixed.buffer] }));
    const copy = structuredClone(fixed.buffer);
    fixed.grow(1);
    result('detach', transfer + ',' + copy.byteLength + ',' + new Uint8Array(fixed.buffer)[10] + ',' + before.byteLength + ',' + fixed.buffer.byteLength);
    result('limit', errorName(() => new WebAssembly.Memory({ initial: 65536 })) + ',' + errorName(() => new WebAssembly.Memory({ initial: 1, maximum: 65536 }).grow(40000)));
    result('features', WebAssembly.validate(wasm(sec(5, [3, 1, 1]))) + ',' + WebAssembly.validate(wasm(sec(5, [0, 1], [0, 1]))));
    // Several memories, memory64 and table64
    const textAt = (memory, at, length) => new TextDecoder().decode(new Uint8Array(memory.buffer, at, length));
    const multi = (await WebAssembly.instantiate(multiMemoryModule())).instance.exports;
    result('multimemory', multiMemoryRun(multi));
    result('multimemory_objects', textAt(multi.m0, 0, 4) + textAt(multi.m1, 16, 4) + textAt(multi.m2, 0, 3) + ',' + (multi.m1 !== multi.m0) + ',' + multi.m1.buffer.byteLength);
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
    result('rewrite', errorName(() => traps.wait()) + ',' + traps.table() + ',' + (refs.get(0) === fixed));
    let down;
    down = new WebAssembly.Instance(new WebAssembly.Module(recursionModule), { env: { down: (n) => (n > 0 ? down(n - 1) + 1 : 0) } }).exports.down;
    // Limit of 64 levels (WasmBridge.cpp), far below the overflow in the browser
    result('recursion', errorName(() => down(100)) + ',' + down(50) + ',' + errorName(() => down(100000)) + ',' + ex.sum());
    // Also in a worker
    const workerCode = 'onmessage = async (e) => { try { const { instance } = await WebAssembly.instantiate(e.data, {}); '
      + 'postMessage(instance.exports.sum() + "," + new Uint8Array(instance.exports.memory.buffer, instance.exports.text_ptr(), 5).join(".")); '
      + '} catch (err) { postMessage("error " + err); } };';
    // Twice: after the end of the first worker (realm released) a new one runs
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
    result('error', String(e && e.stack || e).replace(/\\s+/g, '_'));
  }
})();
</script>`;

const PROGRAM_PAGE = (name) =>
  `<!doctype html><title>Emscripten</title><body>Emscripten<script src="/${name}.js"></script>`;

// A page with 64 MB memory and a cycle over both sides like Emscripten glue: the import calls
// exports of its own instance
const LEAK_PAGES = 1024;
const LEAK_PAGE = `<!doctype html><title>Cycle</title><body>Cycle<script>
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

// A long living worker, per job a new instance with 16 MB and an import from JS. The worker
// thread must return to the event loop of the host in between, else no FinalizationRegistry
// fires there (memory and values from JS would stay until the end of the worker).
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
  // Some garbage, so JSC collects
  for (let i = 0; i < 20000; i++) new Array(8);
  postMessage([n, ex.callF() + '.' + ex.g() + ',' + finalized]);
};`;
const JOBS_PAGE = `<!doctype html><title>Jobs</title><body>Jobs<script>
const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(JOBS_WORKER)}], { type: 'text/javascript' })));
worker.onmessage = ({ data: [n, value] }) => console.log('RESULT job' + n + '=' + value);
window.job = (n) => worker.postMessage(n);
console.log('RESULT jobs=ready');
</script>`;

// Two iframes of different origins in the same engine thread: the second guesses ids of memories
// and bends WeakMap so the API uses them. Only the own id may work (checked in WasmBridge.cpp
// and wasm-host.js).
const REALMS_PAGE = (victimURL) => `<!doctype html><title>Realms</title><body>Realms<script>
const frame = (src) => document.body.appendChild(Object.assign(document.createElement('iframe'), { src }));
const victim = frame('${victimURL}');
onmessage = ({ data: [key, value] }) => {
  if (key === 'ready')
    frame('/attacker.html');
  if (key === 'attack')
    victim.contentWindow.postMessage(['check'], '*');
  if (key !== 'ready')
    console.log('RESULT ' + key + '=' + value);
};
</script>`;
const VICTIM_PAGE = `<!doctype html><title>Victim</title><body>Victim<script>
const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
new Uint8Array(memory.buffer).set(new TextEncoder().encode('SECRET'));
onmessage = () => parent.postMessage(['victim', new TextDecoder().decode(new Uint8Array(memory.buffer, 0, 6)) + ',' + memory.buffer.byteLength], '*');
parent.postMessage(['ready'], '*');
</script>`;
const ATTACKER_PAGE = `<!doctype html><title>Attack</title><body>Attack<script>
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
// ()->i32: reads the first word of the imported memory
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
parent.postMessage(['attack', control + ',' + hits.join(',') + ',' + (ownId > 1)], '*');
</script>`;

const fixtures = path.join(root, 'tests', 'fixtures', 'wasm');
const { url: victimURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(VICTIM_PAGE),
);
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  if (req.url === '/program.html' || req.url === '/program64.html')
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(PROGRAM_PAGE(req.url.slice(1, -5)));
  if (req.url === '/realms.html')
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(REALMS_PAGE(victimURL));
  if (req.url === '/attacker.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ATTACKER_PAGE);
  if (req.url.startsWith('/leak.html'))
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LEAK_PAGE);
  if (req.url === '/jobs.html')
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(JOBS_PAGE);
  if (req.url === '/grow.html')
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        '<!doctype html><title>Grow</title><body>Grow<script>console.log("RESULT growpage=ready")</script>',
      );
  const file = path.join(fixtures, path.basename(req.url));
  if (/\.(wasm|js)$/.test(req.url) && fs.existsSync(file))
    return res
      .writeHead(200, {
        'Content-Type': req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      })
      .end(fs.readFileSync(file));
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'wasm-token-0123456789abcdef' });
// gc() in the web workers of the engine (host side of the bridge)
const browser = await launch({ args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(?: \((?:https?|file):[^)]*\))?$/);
async function result(key) {
  const value = await results.wait(key, TIMEOUT, () => results.has('error'));
  return value ?? (results.has('error') ? `error: ${results.get('error')}` : null);
}

await openHost(page, stack.app({ url: siteURL }));

check(
  'WebAssembly there, not enumerable',
  (await result('typeof')) === 'object,false,[object WebAssembly]',
  results.get('typeof'),
);
check('validate', (await result('validate')) === 'true,false', results.get('validate'));
check('functions (also SIMD)', (await result('sum')) === '80,80', results.get('sum'));
check('read memory.buffer', (await result('read')) === 'Hallo WebAssembly', results.get('read'));
check('write memory.buffer', (await result('write')) === 'true', results.get('write'));
check(
  'grow (old buffer detached)',
  (await result('grow')) === '2,4,0,262144,80',
  results.get('grow'),
);
check('write the new page', (await result('poke')) === '1234,1234', results.get('poke'));
check('access outside traps', (await result('trap')) === 'true,RuntimeError', results.get('trap'));
check('Atomics', (await result('atomic')) === '42', results.get('atomic'));
check(
  'Module.imports',
  (await result('imports')) === 'env.add:function/env.g:global',
  results.get('imports'),
);
check(
  'bridge without a visible symbol',
  /^(\d+),\1$/.test(await result('symbols')),
  results.get('symbols'),
);
check(
  'imports, i64, exception through WASM',
  (await result('calls')) === '6,13/5,1099511627776,42,from JS',
  results.get('calls'),
);
check(
  'Memory, Table, Global',
  (await result('objects')) === '131072,7,true,9',
  results.get('objects'),
);
check('CompileError', (await result('compileerror')) === 'true', results.get('compileerror'));
check(
  'memory.buffer not detachable',
  (await result('detach')) === 'TypeError,TypeError,65536,7,0,131072',
  results.get('detach'),
);
check('memory limit', (await result('limit')) === 'RangeError,RangeError', results.get('limit'));
check(
  'validate: without threads, with several memories',
  (await result('features')) === 'false,true',
  results.get('features'),
);
check(
  'several memories',
  (await result('multimemory')) === MULTI_MEMORY_RESULT,
  results.get('multimemory'),
);
check(
  'several memories as Memory objects',
  (await result('multimemory_objects')) === 'ZweiZweiDre,true,131072',
  results.get('multimemory_objects'),
);
check('memory64', (await result('memory64')) === MEMORY64_RESULT, results.get('memory64'));
check(
  'memory64: buffer and grow with BigInt',
  (await result('memory64_js')) === 'Hallo,77,3,4,262144,TypeError,1',
  results.get('memory64_js'),
);
check(
  'table64',
  (await result('table64')) === '2,42,RuntimeError,TypeError,42,2,3,1',
  results.get('table64'),
);
check(
  'wait traps, table with init, Memory as externref',
  (await result('rewrite')) === 'RuntimeError,42,true',
  results.get('rewrite'),
);
check(
  'recursion JS <-> WASM too deep',
  (await result('recursion')) === 'RangeError,50,RangeError,80',
  results.get('recursion'),
);
check(
  'WebAssembly in a worker, a second worker afterwards',
  (await result('worker')) === '80,72.97.108.108.111/80,72.97.108.108.111',
  results.get('worker'),
);

// Emscripten program with JS glue (instantiateStreaming, the memory grows)
await load(page, `${siteURL}program.html`);
check(
  'Emscripten program',
  (await result('emscripten')) === PROGRAM_RESULT,
  results.get('emscripten'),
);

// The same program with -sMEMORY64 (i64 memory and table64)
results.delete('emscripten');
await load(page, `${siteURL}program64.html`);
check(
  'Emscripten program with memory64',
  (await result('emscripten')) === PROGRAM_RESULT,
  results.get('emscripten'),
);

// Memory of another origin: no buffer, grow or import with its id
await load(page, `${siteURL}realms.html`);
check(
  'foreign memory with a guessed id blocked',
  (await result('attack')) === 'true,0,0,0,true',
  results.get('attack'),
);
check(
  'memory of the other origin unchanged',
  (await result('victim')) === 'SECRET,65536',
  results.get('victim'),
);

// Used memory of the engine in MB (malloc)
const usedMB = () => page.evaluate(() => window.blTest.browser.debug.memoryUsed() / 2 ** 20);
const run = (source) => page.evaluate((source) => window.blTest.eval(source), source);

// Jobs in a worker: memory and values of earlier instances are freed. gc() of the host side in
// all engine workers that answer right now.
async function hostGC() {
  await Promise.all(
    page
      .workers()
      .map((worker) =>
        Promise.race([
          worker.evaluate(() => globalThis.gc && gc()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]),
      ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await load(page, `${siteURL}jobs.html`);
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
const jobsGrown = (await usedMB()) - beforeJobs;
check(
  'worker: memory of earlier instances freed',
  lastJob === '23.23,true' && jobsGrown < (6 * JOB_PAGES) / 16,
  `${lastJob}, ${jobsGrown.toFixed(0)} MB more after 20 jobs of ${JOB_PAGES / 16} MB`,
);

// Grow by exactly the pages like the standard, with a limited reserve: 128 MB grown by 1 MB use
// a quarter of reserve, not double
await load(page, `${siteURL}grow.html`);
await result('growpage');
await run(
  'window.grown = new WebAssembly.Memory({ initial: 2048 }); console.log("RESULT created=1")',
);
await result('created');
const beforeGrow = await usedMB();
await run('grown.grow(16); console.log("RESULT grown=" + grown.buffer.byteLength / 2 ** 20)');
const grownSize = Number(await result('grown'));
const grownUsed = (await usedMB()) - beforeGrow;
check(
  'memory.grow with a limited reserve',
  grownSize === 129 && grownUsed < 48,
  `${grownUsed.toFixed(0)} MB more for 128 -> ${grownSize} MB`,
);

// Many pages with a cycle and 64 MB: the memory is freed with the page
const engineBytes = () => page.evaluate(() => window.blTest.memory());
async function visitLeakPages(from, to) {
  for (let i = from; i < to; i++) {
    await load(page, `${siteURL}leak.html?key=leak${i}`);
    if ((await result('leak' + i)) !== '5') return false;
  }
  return true;
}
const warm = await visitLeakPages(0, 4);
const start = await engineBytes();
const visited = warm && (await visitLeakPages(4, 24));
const grown = ((await engineBytes()) - start) / 2 ** 20;
check(
  'memory of old pages freed',
  visited && grown < (8 * LEAK_PAGES) / 16,
  `${grown} MB more after 20 pages of ${LEAK_PAGES / 16} MB`,
);

await browser.close();
finish();
