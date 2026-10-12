// WebAssembly-API (engine/js/wasm-guest.js) und Host-Seite ueber die
// nachgebaute Bruecke, ohne Engine: node tests/wasm/api-test.mjs
import fs from 'node:fs';
import { createWebAssembly } from './bridge-sim.mjs';
const W = createWebAssembly();
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) failed++; };
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
let trap = null;
try { ex.oob(); } catch (e) { trap = e; }
check('RuntimeError', trap instanceof W.RuntimeError, trap && trap.message);
try { new W.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 99])); } catch (e) { trap = e; }
check('CompileError', trap instanceof W.CompileError, trap && trap.message);

// Imports: Funktion, Global, Tabelle, i64, Ausnahmen durch WebAssembly hindurch
// (handgeschriebenes Modul)
const str = (t) => [t.length, ...new TextEncoder().encode(t)];
const sec = (id, ...items) => { const body = [items.length, ...items.flat()]; return [id, body.length, ...body]; };
const code = (...instr) => { const body = [0, ...instr, 11]; return [body.length, ...body]; };
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
  ...sec(1, [96, 1, 127, 1, 127], [96, 1, 126, 1, 126], [96, 0, 1, 127]),
  ...sec(2, [...str('env'), ...str('add'), 0, 0], [...str('env'), ...str('g'), 3, 127, 0]),
  ...sec(3, [0], [1], [2]),
  ...sec(7, [...str('call'), 0, 1], [...str('big'), 0, 2], [...str('read'), 0, 3]),
  ...sec(10, code(32, 0, 16, 0), code(32, 0), code(35, 0))]);
const m2 = new W.Module(bytes);
let calls = [];
const i2 = new W.Instance(m2, { env: { add: (x) => { calls.push(x); if (x === 13) throw new Error('aus JS'); return x + 1; }, g: 42 } });
check('Import aufgerufen', i2.exports.call(5) === 6 && calls[0] === 5);
check('i64 als BigInt', i2.exports.big(2n ** 40n) === 2n ** 40n);
let thrown = null;
try { i2.exports.call(13); } catch (e) { thrown = e; }
check('JS-Ausnahme durch WASM', thrown instanceof Error && thrown.message === 'aus JS');
check('Global-Import', i2.exports.read() === 42);
const g = new W.Global({ value: 'i64', mutable: true }, 5n);
g.value = 7n;
check('Global', g.value === 7n);
const table = new W.Table({ element: 'anyfunc', initial: 2 });
table.set(0, i2.exports.call);
check('Tabelle', table.get(0) === i2.exports.call && table.get(1) === null && table.length === 2 && table.grow(1) === 2);
const mem = new W.Memory({ initial: 1, maximum: 2 });
check('Memory', mem.buffer.byteLength === 65536 && mem.grow(1) === 1);
let range = null;
try { mem.grow(1); } catch (e) { range = e; }
check('Memory max', range instanceof RangeError);
check('toStringTag', Object.prototype.toString.call(W) === '[object WebAssembly]' && String(mem) === '[object WebAssembly.Memory]');
console.log(failed ? failed + ' fehlgeschlagen' : 'Alle ok');
process.exit(failed ? 1 : 0);
