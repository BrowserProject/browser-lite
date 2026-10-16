// Umgeschriebenes Modul (engine/js/wasm-rewrite.js) gegen das Original:
// gleiche Ergebnisse, auch nach grow (Speicher zieht um), bei SIMD/Atomics,
// mehreren Speichern und memory64.
//   node tests/wasm/rewrite-test.mjs [modul.wasm]
import fs from 'node:fs';
import vm from 'node:vm';
import { MEMORY64_RESULT, MULTI_MEMORY_RESULT, code, memory64Module, memory64Run, multiMemoryModule, multiMemoryRun, sec, str, wasm } from './wasm-bytes.mjs';
vm.runInThisContext(fs.readFileSync(new URL('../../engine/js/wasm-rewrite.js', import.meta.url), 'utf8'));
const rewrite = globalThis.blWasmRewrite;

// "Engine": geteilter Speicher, ein Bereich pro Speicher des Moduls ab 1 MB.
// grow zieht den Bereich immer ans Ende um
async function instantiateRewritten(bytes, imports = {}) {
  const engine = new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true });
  const { bytes: out, info } = rewrite(bytes);
  WebAssembly.validate(out) || console.log('UNGUELTIG');
  const pageBytes = 65536;
  let top = 1 << 20;
  const reserve = (pages) => {
    const base = top;
    top += (pages + 1) * pageBytes;
    if (top > engine.buffer.byteLength)
      engine.grow(Math.ceil((top - engine.buffer.byteLength) / pageBytes));
    return base;
  };
  const __bl = { memory: engine };
  const regions = info.memories.map((memory, k) => {
    const region = { base: reserve(memory.min) };
    const g = {
      base: new WebAssembly.Global({ value: 'i32', mutable: true }, region.base),
      bytes: new WebAssembly.Global({ value: 'i64', mutable: true }, BigInt(memory.min * pageBytes)),
      pages: new WebAssembly.Global({ value: 'i32', mutable: true }, memory.min),
    };
    const grow = (delta) => {
      const old = g.pages.value;
      if (delta < 0 || (memory.max !== undefined && old + delta > memory.max)) return -1;
      const newBase = reserve(old + delta);
      const view = new Uint8Array(engine.buffer);
      view.copyWithin(newBase, region.base, region.base + old * pageBytes);
      view.fill(0, newBase + old * pageBytes, newBase + (old + delta) * pageBytes);
      region.base = newBase;
      g.base.value = region.base; g.pages.value = old + delta; g.bytes.value = BigInt((old + delta) * pageBytes);
      return old;
    };
    Object.assign(__bl, { ['grow' + k]: grow, ['base' + k]: g.base, ['bytes' + k]: g.bytes, ['pages' + k]: g.pages });
    return region;
  });
  const instance = (await WebAssembly.instantiate(out, { ...imports, __bl })).instance;
  instance.exports.__bl_init();
  return { ex: instance.exports, info, engine, region: regions[0] };
}

const results = [];
const same = (name, a, b) => { const ok = a === b; results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${a} / ${b}`); };
const trapName = (fn) => { try { fn(); return 'kein'; } catch (e) { return e.constructor.name; } };

// Testmodul (Original gegen umgeschrieben)
const bytes = fs.readFileSync(process.argv[2] || new URL('../e2e/fixtures/small.wasm', import.meta.url));
const original = (await WebAssembly.instantiate(bytes)).instance.exports;
const { ex, info, engine, region } = await instantiateRewritten(bytes);
same('sum', ex.sum(), original.sum());
same('simd_sum', ex.simd_sum(), original.simd_sum());
const text = (mem, ptr) => new TextDecoder().decode(new Uint8Array(mem).slice(ptr, ptr + 17));
same('text', text(engine.buffer, region.base + ex.text_ptr()), text(original.memory.buffer, original.text_ptr()));
same('copy', ex.copy(5), original.copy(5));
same('atomic', ex.atomic(), original.atomic());
same('size', ex.size(), original.size());
same('grow', ex.grow(3), original.grow(3));
same('size nach grow', ex.size(), original.size());
same('sum nach grow (umgezogen)', ex.sum(), original.sum());
same('poke neue Seite', ex.poke(ex.size() - 1), original.poke(original.size() - 1));
same('Zugriff ausserhalb faengt', trapName(() => ex.oob()), trapName(() => original.oob()));
console.log(info.exports.map((e) => e.name + ':' + e.kind).join(','));

// Handgeschriebene Module: Original und umgeschrieben gleich
async function both(name, module, run) {
  const native = (await WebAssembly.instantiate(module)).instance.exports;
  const rewritten = (await instantiateRewritten(module)).ex;
  same(name, run(rewritten), run(native));
}
const i32 = 0x7f;

// Tabelle mit Init-Ausdruck (ref.func) und call_indirect: Indizes verschoben
await both('Tabelle mit Init-Ausdruck', wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(3, [0], [0], [0]),
  sec(4, [0x40, 0x00, 0x70, 0x00, 1, 0xd2, 1, 0x0b]),
  sec(5, [0x00, 1]),
  sec(7, [...str('run'), 0, 2]),
  sec(10, code(0x41, 7), code(0x41, 42), code(0x41, 0, 0x11, 0, 0))), (e) => e.run());

// memory.atomic.wait32/64 auf nicht geteiltem Speicher faengt (wartet nicht)
const waitModule = wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(3, [0], [0]),
  sec(5, [0x00, 1]),
  sec(7, [...str('wait32'), 0, 0], [...str('wait64'), 0, 1]),
  sec(10, code(0x41, 0, 0x41, 0, 0x42, 0, 0xfe, 0x01, 2, 0), code(0x41, 0, 0x42, 0, 0x42, 0, 0xfe, 0x02, 3, 0)));
await both('wait32 faengt', waitModule, (e) => trapName(() => e.wait32()));
await both('wait64 faengt', waitModule, (e) => trapName(() => e.wait64()));

// Start-Funktion sieht die Daten-Segmente schon
await both('Start-Funktion nach den Daten', wasm(
  sec(1, [0x60, 0, 0], [0x60, 0, 1, i32]),
  sec(3, [0], [1]),
  sec(5, [0x00, 1]),
  sec(6, [i32, 1, 0x41, 0, 0x0b]),
  sec(7, [...str('get'), 0, 1]),
  [8, 1, 0],
  sec(10, code(0x41, 0, 0x2d, 0, 0, 0x24, 0), code(0x23, 0)),
  sec(11, [0x00, 0x41, 0, 0x0b, 1, 65])), (e) => e.get());

// Mehrere Speicher und memory64 gegen das gemessene Original (node 22 kann
// memory.copy zwischen i32- und i64-Speicher noch nicht)
async function expected(name, module, run, result) {
  same(name, run((await instantiateRewritten(module)).ex), result);
  const native = await WebAssembly.instantiate(module).catch(() => null);
  if (native)
    same(name + ' (Original)', run(native.instance.exports), result);
}
await expected('Mehrere Speicher', multiMemoryModule(), multiMemoryRun, MULTI_MEMORY_RESULT);
await expected('memory64', memory64Module(), memory64Run, MEMORY64_RESULT);

process.exit(results.every(Boolean) ? 0 : 1);
