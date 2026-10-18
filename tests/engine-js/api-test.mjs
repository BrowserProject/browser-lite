// WebAssembly API (engine/js/wasm-guest.js) and host side over the simulated bridge, without the
// engine: node tests/engine-js/api-test.mjs
import fs from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createBridgeSim, MAX_CALL_DEPTH, MAX_MEMORY_PAGES } from './bridge-sim.mjs';
import {
  MEMORY64_RESULT,
  MULTI_MEMORY_RESULT,
  code,
  memory64Module,
  memory64Run,
  multiMemoryModule,
  multiMemoryRun,
  sec,
  str,
  wasm,
} from '../fixtures/wasm-bytes.mjs';
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const sim = createBridgeSim();
const W = sim.WebAssembly;
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};
const thrown = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
// GC on both sides, then let the FinalizationRegistry tasks run
const collect = async () => {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const t = fs.readFileSync(new URL('../fixtures/wasm/small.wasm', import.meta.url));
check('validate', W.validate(t) === true && W.validate(new Uint8Array([1, 2, 3])) === false);
const { module, instance } = await W.instantiate(t, {});
check('instanceof', module instanceof W.Module && instance instanceof W.Instance);
check(
  'Module.exports',
  W.Module.exports(module)
    .map((e) => e.name + ':' + e.kind)
    .join(',')
    .startsWith('memory:memory,sum:function'),
);
const ex = instance.exports;
check('sum', ex.sum() === 80, ex.sum());
check('simd', ex.simd_sum() === 80);
check('memory export', ex.memory instanceof W.Memory);
check(
  'size/grow',
  ex.size() === 2 &&
    ex.grow(1) === 2 &&
    ex.size() === 3 &&
    ex.memory.grow(1) === 3 &&
    ex.size() === 4,
);
check('sum after grow', ex.sum() === 80);
check('Function name/length', typeof ex.sum === 'function' && ex.copy.length === 1);
let trap = thrown(() => ex.oob());
check('RuntimeError', trap instanceof W.RuntimeError, trap && trap.message);
trap = thrown(() => new W.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 99])));
check('CompileError', trap instanceof W.CompileError, trap && trap.message);

// Imports: function, global, table, i64, exceptions through WebAssembly
const i32 = 0x7f,
  i64 = 0x7e,
  externref = 0x6f;
const bytes = wasm(
  sec(1, [0x60, 1, i32, 1, i32], [0x60, 1, i64, 1, i64], [0x60, 0, 1, i32]),
  sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, i32, 0]),
  sec(3, [0], [1], [2]),
  sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0)),
);
const m2 = new W.Module(bytes);
let calls = [];
const i2 = new W.Instance(m2, {
  env: {
    add: (x) => {
      calls.push(x);
      if (x === 13) throw new Error('from JS');
      return x + 1;
    },
    g: 42,
  },
});
check('import called', i2.exports.call(5) === 6 && calls[0] === 5);
check('i64 as BigInt', i2.exports.big(2n ** 40n) === 2n ** 40n);
const fromJS = thrown(() => i2.exports.call(13));
check('JS exception through WASM', fromJS instanceof Error && fromJS.message === 'from JS');
check('global import', i2.exports.read() === 42);
const g = new W.Global({ value: 'i64', mutable: true }, 5n);
g.value = 7n;
check('Global', g.value === 7n);
const table = new W.Table({ element: 'anyfunc', initial: 2 });
table.set(0, i2.exports.call);
check(
  'table',
  table.get(0) === i2.exports.call &&
    table.get(1) === null &&
    table.length === 2 &&
    table.grow(1) === 2,
);
const mem = new W.Memory({ initial: 1, maximum: 2 });
check('Memory', mem.buffer.byteLength === 65536 && mem.grow(1) === 1);
check('Memory max', thrown(() => mem.grow(1)) instanceof RangeError);
check(
  'toStringTag',
  Object.prototype.toString.call(W) === '[object WebAssembly]' &&
    String(mem) === '[object WebAssembly.Memory]',
);

// Memory limit: never 4 GB (size_t overflow in the engine)
check('memory too large', thrown(() => new W.Memory({ initial: 65536 })) instanceof RangeError);
const big = new W.Memory({ initial: 1, maximum: 65536 });
check(
  'memory does not grow past the limit',
  thrown(() => big.grow(MAX_MEMORY_PAGES)) instanceof RangeError,
);
const bigModule = wasm(sec(5, [0x00, ...[0x80, 0x80, 0x04]]));
check(
  'module with too large a memory',
  thrown(() => new W.Instance(new W.Module(bigModule), {})) instanceof RangeError,
);

// validate only says yes when compile works too (feature detection of the pages)
const sharedMemory = wasm(sec(5, [0x03, 1, 1]));
const memory64 = wasm(sec(5, [0x04, 1]));
const twoMemories = wasm(sec(5, [0x00, 1], [0x00, 1]));
check('validate: shared memory', WebAssembly.validate(sharedMemory) && !W.validate(sharedMemory));
check('validate: memory64, several memories', W.validate(memory64) && W.validate(twoMemories));

// Several memories: each its own Memory object with its own region
const multi = (await W.instantiate(multiMemoryModule())).instance.exports;
const textAt = (memory, at, length) =>
  new TextDecoder().decode(new Uint8Array(memory.buffer, at, length));
const multiResult = multiMemoryRun(multi);
check('several memories: calls', multiResult === MULTI_MEMORY_RESULT, multiResult);
check(
  'several memories: objects',
  multi.m0 instanceof W.Memory &&
    multi.m1 !== multi.m0 &&
    multi.m2 !== multi.m1 &&
    textAt(multi.m1, 16, 4) === 'Zwei' &&
    textAt(multi.m0, 0, 4) === 'Zwei' &&
    textAt(multi.m2, 0, 3) === 'Dre' &&
    multi.m1.buffer.byteLength === 2 * 65536 &&
    multi.m2.grow(1n) === 1n &&
    multi.m2.buffer.byteLength === 2 * 65536,
);

// memory64: limits and grow with BigInt like in Chromium
const m64 = (await W.instantiate(memory64Module())).instance.exports;
const m64Result = memory64Run(m64);
check('memory64: calls', m64Result === MEMORY64_RESULT, m64Result);
check(
  'memory64: Memory',
  textAt(m64.memory, 8, 5) === 'Hallo' &&
    m64.memory.grow(1n) === 3n &&
    m64.size() === 4n &&
    thrown(() => m64.memory.grow(1n)) instanceof RangeError,
);
const own64 = new W.Memory({ address: 'i64', initial: 1n, maximum: 3n });
check(
  'memory64: new Memory',
  own64.buffer.byteLength === 65536 &&
    own64.grow(2n) === 1n &&
    thrown(() => own64.grow(1n)) instanceof RangeError &&
    thrown(() => new W.Memory({ address: 'i64', initial: 1 })) instanceof TypeError &&
    thrown(() => own64.grow(1)) instanceof TypeError &&
    thrown(() => new W.Memory({ address: 'i128', initial: 1 })) instanceof TypeError &&
    thrown(() => new W.Memory({ initial: 1n })) instanceof TypeError,
);

// Imported memories: type and limits must match
const importsTwo = wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(2, [...str('env'), ...str('a'), 2, 0x01, 1, 2], [...str('env'), ...str('b'), 2, 0x04, 1]),
  sec(3, [0]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(0x42, 0, 0x28, 0x42, 1, 0, 0x41, 0, 0x28, 2, 0, 0x6a)),
);
const importedA = new W.Memory({ initial: 1, maximum: 2 }),
  importedB = new W.Memory({ address: 'i64', initial: 1n });
const twoModule = new W.Module(importsTwo);
const linked = (a, b) => thrown(() => new W.Instance(twoModule, { env: { a, b } }));
check(
  'memory imports',
  new W.Instance(twoModule, { env: { a: importedA, b: importedB } }).exports.f() === 0 &&
    linked(importedB, importedA) instanceof W.LinkError &&
    linked(new W.Memory({ initial: 1 }), importedB) instanceof W.LinkError &&
    linked(new W.Memory({ initial: 1, maximum: 3 }), importedB) instanceof W.LinkError &&
    linked(new W.Memory({ initial: 0, maximum: 2 }), importedB) instanceof W.LinkError &&
    linked(importedA, new W.Memory({ address: 'i64', initial: 0n })) instanceof W.LinkError,
  String(linked(importedB, importedA)),
);

// API objects as externref come back unchanged
const refTable = new W.Table({ element: 'externref', initial: 2 });
const plain = { name: 'object' };
refTable.set(0, mem);
refTable.set(1, plain);
const refGlobal = new W.Global({ value: 'externref', mutable: true }, mem);
check(
  'externref: Memory, object',
  refTable.get(0) === mem && refTable.get(1) === plain && refGlobal.value === mem,
);

// Tag and Exception, also through WebAssembly
const tag = new W.Tag({ parameters: ['i32'] });
const exception = new W.Exception(tag, [42]);
check(
  'Exception',
  exception instanceof W.Exception && exception.is(tag) && exception.getArg(tag, 0) === 42,
);
const viaWasm = thrown(() =>
  new W.Instance(m2, {
    env: {
      add: () => {
        throw exception;
      },
      g: 1,
    },
  }).exports.call(1),
);
check('Exception through WASM', viaWasm === exception, viaWasm);

// Functions keep instance and memory alive: keep only the function, GC
const storeLoad = wasm(
  sec(1, [0x60, 1, i32, 1, i32]),
  sec(3, [0]),
  sec(5, [0x00, 1]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(0x41, 0, 0x20, 0, 0x36, 2, 0, 0x41, 0, 0x28, 2, 0)),
);
let f = (await W.instantiate(storeLoad)).instance.exports.f;
await collect();
const afterGC = thrown(() => f(7)) || f(7);
check('memory lives with the function', afterGC === 7, afterGC);
const memoriesBefore = sim.memories.size;
f = null;
await collect();
check(
  'memory freed with the last function',
  sim.memories.size === memoriesBefore - 1,
  sim.memories.size + ' of ' + memoriesBefore,
);

// Values from JS for the host side are freed again
const identity = wasm(
  sec(1, [0x60, 1, externref, 1, externref]),
  sec(3, [0]),
  sec(7, [...str('id'), 0, 0]),
  sec(10, code(0x20, 0)),
);
const id = (await W.instantiate(identity)).instance.exports.id;
const guestsBefore = sim.guests.size;
for (let i = 0; i < 200; i++) id({ i });
await collect();
id(null);
check(
  'values from JS freed',
  sim.guests.size < guestsBefore + 20,
  sim.guests.size + ' (before ' + guestsBefore + ')',
);

// Deep recursion JS <-> WebAssembly: RangeError, everything works afterwards
const recursion = wasm(
  sec(1, [0x60, 1, i32, 1, i32]),
  sec(2, [...str('env'), ...str('down'), 0, 0]),
  sec(3, [0]),
  sec(7, [...str('down'), 0, 1]),
  sec(10, code(0x20, 0, 0x10, 0)),
);
let down;
down = new W.Instance(new W.Module(recursion), {
  env: { down: (n) => (n > 0 ? down(n - 1) + 1 : 0) },
}).exports.down;
const tooDeep = thrown(() => down(MAX_CALL_DEPTH + 10));
check('recursion too deep', tooDeep instanceof RangeError, tooDeep);
check(
  'works afterwards',
  down(10) === 10 && thrown(() => down(100000)) instanceof RangeError && ex.sum() === 80,
);

// Second realm in the same thread (for example a cross-origin iframe): no access to memory of
// the first, not even with a guessed id
const other = sim.createRealm();
const W2 = other.WebAssembly;
const victim = new W.Memory({ initial: 1, maximum: 4 });
const victimId = Math.max(...sim.memories.keys());
const pages = () => sim.memories.get(victimId).pages;
const bridgeUse = [
  thrown(() => other.bridge.memoryBuffer(victimId)) instanceof TypeError,
  thrown(() => other.bridge.memoryGrow(victimId, 1)) instanceof TypeError,
  (other.bridge.memoryRelease(victimId), sim.memories.get(victimId).refs === 1),
];
check('bridge: foreign memory', bridgeUse.every(Boolean) && pages() === 1, bridgeUse.join(','));

// Host side: instantiate only with memory of the own realm
const compiled = other.bridge.host(1, [9, storeLoad]);
const otherMemory = other.bridge.memoryCreate(1, -1);
const status = (memoryId) => other.bridge.host(2, [6, compiled[3], 2, memoryId])[1];
check(
  'host: instantiate with foreign memory',
  compiled[1] === 0 && status(victimId) === 2 && status(otherMemory) === 0,
);

// API with bent built-ins (the page can change WeakMap): the own id works, a foreign one not
const memoryImport = wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(2, [...str('env'), ...str('memory'), 2, 0, 1]),
  sec(3, [0]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(0x41, 0, 0x28, 2, 0)),
);
const forged = (memoryId, work) => {
  const fake = {};
  const { get, has } = WeakMap.prototype;
  WeakMap.prototype.get = function (key) {
    return key === fake ? { kind: 'memory', memoryId, address: 'i32' } : get.call(this, key);
  };
  WeakMap.prototype.has = function (key) {
    return key === fake || has.call(this, key);
  };
  try {
    return work(fake);
  } catch (e) {
    return e;
  } finally {
    Object.assign(WeakMap.prototype, { get, has });
  }
};
const bufferOf = (fake) =>
  Object.getOwnPropertyDescriptor(W2.Memory.prototype, 'buffer').get.call(fake);
const ownMemory = new W2.Memory({ initial: 1 });
const ownId = Math.max(...sim.memories.keys());
const forgedImport = (fake) =>
  new W2.Instance(new W2.Module(memoryImport), { env: { memory: fake } }).exports.f();
check(
  'API: own id with bent WeakMap',
  forged(ownId, bufferOf).byteLength === 65536 &&
    forged(ownId, forgedImport) === 0 &&
    ownMemory.grow(0) === 1,
);
const forgedUse = [
  forged(victimId, bufferOf),
  forged(victimId, (fake) => W2.Memory.prototype.grow.call(fake, 1)),
  forged(victimId, forgedImport),
];
check(
  'API: foreign id with bent WeakMap',
  forgedUse[0] instanceof TypeError &&
    forgedUse[1] instanceof TypeError &&
    forgedUse[2] instanceof Error &&
    pages() === 1,
  forgedUse.map(String).join(' / '),
);

// The second realm released: the first keeps running
other.releaseRealm();
check(
  'other realm freed, first lives',
  !sim.memories.has(ownId) &&
    !sim.memories.has(otherMemory) &&
    sim.memories.has(victimId) &&
    victim.buffer.byteLength === 65536 &&
    ex.sum() === 80,
);

// Realm released (navigation): memory and values freed
sim.releaseRealm();
check(
  'realm freed',
  sim.memories.size === 0 && sim.guests.size === 0,
  sim.memories.size + ',' + sim.guests.size,
);

console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
