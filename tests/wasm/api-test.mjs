// WebAssembly-API (engine/js/wasm-guest.js) und Host-Seite ueber die
// nachgebaute Bruecke, ohne Engine: node tests/wasm/api-test.mjs
import fs from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createBridgeSim, MAX_CALL_DEPTH, MAX_MEMORY_PAGES } from './bridge-sim.mjs';
import { code, sec, str, wasm } from './wasm-bytes.mjs';
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const sim = createBridgeSim();
const W = sim.WebAssembly;
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) failed++; };
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };
// GC auf beiden Seiten, dann die FinalizationRegistry-Aufgaben laufen lassen
const collect = async () => { for (let i = 0; i < 3; i++) { gc(); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const t = fs.readFileSync(new URL('../e2e/fixtures/small.wasm', import.meta.url));
check('validate', W.validate(t) === true && W.validate(new Uint8Array([1, 2, 3])) === false);
const { module, instance } = await W.instantiate(t, {});
check('instanceof', module instanceof W.Module && instance instanceof W.Instance);
check('Module.exports', W.Module.exports(module).map((e) => e.name + ':' + e.kind).join(',').startsWith('memory:memory,sum:function'));
const ex = instance.exports;
check('sum', ex.sum() === 80, ex.sum());
check('simd', ex.simd_sum() === 80);
check('memory export', ex.memory instanceof W.Memory);
check('size/grow', ex.size() === 2 && ex.grow(1) === 2 && ex.size() === 3 && ex.memory.grow(1) === 3 && ex.size() === 4);
check('sum nach grow', ex.sum() === 80);
check('Function name/length', typeof ex.sum === 'function' && ex.copy.length === 1);
let trap = thrown(() => ex.oob());
check('RuntimeError', trap instanceof W.RuntimeError, trap && trap.message);
trap = thrown(() => new W.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 99])));
check('CompileError', trap instanceof W.CompileError, trap && trap.message);

// Imports: Funktion, Global, Tabelle, i64, Ausnahmen durch WebAssembly hindurch
const i32 = 0x7f, i64 = 0x7e, externref = 0x6f;
const bytes = wasm(
  sec(1, [0x60, 1, i32, 1, i32], [0x60, 1, i64, 1, i64], [0x60, 0, 1, i32]),
  sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, i32, 0]),
  sec(3, [0], [1], [2]),
  sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0)));
const m2 = new W.Module(bytes);
let calls = [];
const i2 = new W.Instance(m2, { env: { add: (x) => { calls.push(x); if (x === 13) throw new Error('aus JS'); return x + 1; }, g: 42 } });
check('Import aufgerufen', i2.exports.call(5) === 6 && calls[0] === 5);
check('i64 als BigInt', i2.exports.big(2n ** 40n) === 2n ** 40n);
const fromJS = thrown(() => i2.exports.call(13));
check('JS-Ausnahme durch WASM', fromJS instanceof Error && fromJS.message === 'aus JS');
check('Global-Import', i2.exports.read() === 42);
const g = new W.Global({ value: 'i64', mutable: true }, 5n);
g.value = 7n;
check('Global', g.value === 7n);
const table = new W.Table({ element: 'anyfunc', initial: 2 });
table.set(0, i2.exports.call);
check('Tabelle', table.get(0) === i2.exports.call && table.get(1) === null && table.length === 2 && table.grow(1) === 2);
const mem = new W.Memory({ initial: 1, maximum: 2 });
check('Memory', mem.buffer.byteLength === 65536 && mem.grow(1) === 1);
check('Memory max', thrown(() => mem.grow(1)) instanceof RangeError);
check('toStringTag', Object.prototype.toString.call(W) === '[object WebAssembly]' && String(mem) === '[object WebAssembly.Memory]');

// Grenze des Speichers: nie 4 GB (size_t-Ueberlauf in der Engine)
check('Memory zu gross', thrown(() => new W.Memory({ initial: 65536 })) instanceof RangeError);
const big = new W.Memory({ initial: 1, maximum: 65536 });
check('Memory waechst nicht ueber die Grenze', thrown(() => big.grow(MAX_MEMORY_PAGES)) instanceof RangeError);
const bigModule = wasm(sec(5, [0x00, ...[0x80, 0x80, 0x04]]));
check('Modul mit zu grossem Speicher', thrown(() => new W.Instance(new W.Module(bigModule), {})) instanceof RangeError);

// validate sagt nur ja, wenn compile auch geht (Feature-Erkennung der Seiten)
const sharedMemory = wasm(sec(5, [0x03, 1, 1]));
const memory64 = wasm(sec(5, [0x04, 1]));
const twoMemories = wasm(sec(5, [0x00, 1], [0x00, 1]));
check('validate: geteilter Speicher', WebAssembly.validate(sharedMemory) && !W.validate(sharedMemory));
check('validate: memory64, mehrere Speicher', !W.validate(memory64) && !W.validate(twoMemories));

// API-Objekte als externref kommen unveraendert zurueck
const refTable = new W.Table({ element: 'externref', initial: 2 });
const plain = { name: 'objekt' };
refTable.set(0, mem);
refTable.set(1, plain);
const refGlobal = new W.Global({ value: 'externref', mutable: true }, mem);
check('externref: Memory, Objekt', refTable.get(0) === mem && refTable.get(1) === plain && refGlobal.value === mem);

// Tag und Exception, auch durch WebAssembly hindurch
const tag = new W.Tag({ parameters: ['i32'] });
const exception = new W.Exception(tag, [42]);
check('Exception', exception instanceof W.Exception && exception.is(tag) && exception.getArg(tag, 0) === 42);
const viaWasm = thrown(() => new W.Instance(m2, { env: { add: () => { throw exception; }, g: 1 } }).exports.call(1));
check('Exception durch WASM', viaWasm === exception, viaWasm);

// Funktionen halten Instanz und Speicher: nur die Funktion behalten, GC
const storeLoad = wasm(
  sec(1, [0x60, 1, i32, 1, i32]),
  sec(3, [0]),
  sec(5, [0x00, 1]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(0x41, 0, 0x20, 0, 0x36, 2, 0, 0x41, 0, 0x28, 2, 0)));
let f = (await W.instantiate(storeLoad)).instance.exports.f;
await collect();
const afterGC = thrown(() => f(7)) || f(7);
check('Speicher lebt mit der Funktion', afterGC === 7, afterGC);
const memoriesBefore = sim.memories.size;
f = null;
await collect();
check('Speicher frei mit der letzten Funktion', sim.memories.size === memoriesBefore - 1, sim.memories.size + ' von ' + memoriesBefore);

// Werte aus JS fuer die Host-Seite werden wieder frei
const identity = wasm(
  sec(1, [0x60, 1, externref, 1, externref]),
  sec(3, [0]),
  sec(7, [...str('id'), 0, 0]),
  sec(10, code(0x20, 0)));
const id = (await W.instantiate(identity)).instance.exports.id;
const guestsBefore = sim.guests.size;
for (let i = 0; i < 200; i++)
  id({ i });
await collect();
id(null);
check('Werte aus JS frei', sim.guests.size < guestsBefore + 20, sim.guests.size + ' (vorher ' + guestsBefore + ')');

// Tiefe Rekursion JS <-> WebAssembly: RangeError, danach geht alles weiter
const recursion = wasm(
  sec(1, [0x60, 1, i32, 1, i32]),
  sec(2, [...str('env'), ...str('down'), 0, 0]),
  sec(3, [0]),
  sec(7, [...str('down'), 0, 1]),
  sec(10, code(0x20, 0, 0x10, 0)));
let down;
down = new W.Instance(new W.Module(recursion), { env: { down: (n) => (n > 0 ? down(n - 1) + 1 : 0) } }).exports.down;
const tooDeep = thrown(() => down(MAX_CALL_DEPTH + 10));
check('Rekursion zu tief', tooDeep instanceof RangeError, tooDeep);
check('Danach weiter', down(10) === 10 && thrown(() => down(100000)) instanceof RangeError && ex.sum() === 80);

// Zweite Realm im selben Thread (z.B. iframe einer anderen Herkunft): kein
// Zugriff auf Speicher der ersten, auch nicht mit geratener id
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
check('Bruecke: fremder Speicher', bridgeUse.every(Boolean) && pages() === 1, bridgeUse.join(','));

// Host-Seite: instantiate nur mit Speicher der eigenen Realm
const compiled = other.bridge.host(1, [9, storeLoad]);
const otherMemory = other.bridge.memoryCreate(1, -1);
const status = (memoryId) => other.bridge.host(2, [6, compiled[3], 2, memoryId])[1];
check('Host: instantiate mit fremdem Speicher', compiled[1] === 0 && status(victimId) === 2 && status(otherMemory) === 0);

// API mit verbogenen Built-ins (die Seite kann WeakMap aendern): die eigene id
// geht, die fremde nicht
const memoryImport = wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(2, [...str('env'), ...str('memory'), 2, 0, 1]),
  sec(3, [0]),
  sec(7, [...str('f'), 0, 0]),
  sec(10, code(0x41, 0, 0x28, 2, 0)));
const forged = (memoryId, work) => {
  const fake = {};
  const { get, has } = WeakMap.prototype;
  WeakMap.prototype.get = function (key) { return key === fake ? { kind: 'memory', memoryId } : get.call(this, key); };
  WeakMap.prototype.has = function (key) { return key === fake || has.call(this, key); };
  try {
    return work(fake);
  } catch (e) {
    return e;
  } finally {
    Object.assign(WeakMap.prototype, { get, has });
  }
};
const bufferOf = (fake) => Object.getOwnPropertyDescriptor(W2.Memory.prototype, 'buffer').get.call(fake);
const ownMemory = new W2.Memory({ initial: 1 });
const ownId = Math.max(...sim.memories.keys());
const forgedImport = (fake) => new W2.Instance(new W2.Module(memoryImport), { env: { memory: fake } }).exports.f();
check('API: eigene id mit verbogenem WeakMap', forged(ownId, bufferOf).byteLength === 65536 && forged(ownId, forgedImport) === 0 && ownMemory.grow(0) === 1);
const forgedUse = [forged(victimId, bufferOf), forged(victimId, (fake) => W2.Memory.prototype.grow.call(fake, 1)), forged(victimId, forgedImport)];
check('API: fremde id mit verbogenem WeakMap', forgedUse[0] instanceof TypeError && forgedUse[1] instanceof TypeError && forgedUse[2] instanceof Error && pages() === 1,
  forgedUse.map(String).join(' / '));

// Die zweite Realm abgebaut: die erste laeuft weiter
other.releaseRealm();
check('Andere Realm frei, erste lebt', !sim.memories.has(ownId) && !sim.memories.has(otherMemory) && sim.memories.has(victimId) && victim.buffer.byteLength === 65536 && ex.sum() === 80);

// Realm abgebaut (Navigation): Speicher und Werte frei
sim.releaseRealm();
check('Realm frei', sim.memories.size === 0 && sim.guests.size === 0, sim.memories.size + ',' + sim.guests.size);

console.log(failed ? failed + ' fehlgeschlagen' : 'Alle ok');
process.exit(failed ? 1 : 0);
