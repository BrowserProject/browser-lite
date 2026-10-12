// Umgeschriebenes Modul (engine/js/wasm-rewrite.js) gegen das Original:
// gleiche Ergebnisse, auch nach grow (Speicher zieht um) und bei SIMD/Atomics.
//   node tests/wasm/rewrite-test.mjs [modul.wasm]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../../engine/js/wasm-rewrite.js', import.meta.url), 'utf8'));
const rewrite = globalThis.blWasmRewrite;
const bytes = fs.readFileSync(process.argv[2] || new URL('../e2e/fixtures/small.wasm', import.meta.url));

// Original
const original = (await WebAssembly.instantiate(bytes)).instance.exports;

// "Engine": geteilter Speicher, Bereich fuer das Modul bei 1 MB
const engine = new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true });
const { bytes: out, info } = rewrite(bytes);
WebAssembly.validate(out) || console.log('UNGUELTIG');
let base = 1 << 20;
const pageBytes = 65536;
const g = {
  base: new WebAssembly.Global({ value: 'i32', mutable: true }, base),
  bytes: new WebAssembly.Global({ value: 'i64', mutable: true }, BigInt(info.memory.min * pageBytes)),
  pages: new WebAssembly.Global({ value: 'i32', mutable: true }, info.memory.min),
};
const grow = (delta) => {
  const old = g.pages.value;
  if (info.memory.max !== undefined && old + delta > info.memory.max) return -1;
  // Neuer Bereich weiter hinten (umziehen), alter Inhalt kopiert
  const newBase = base + (old + 16) * pageBytes;
  const needed = newBase + (old + delta) * pageBytes;
  if (needed > engine.buffer.byteLength) engine.grow(Math.ceil((needed - engine.buffer.byteLength) / pageBytes));
  const view = new Uint8Array(engine.buffer);
  view.copyWithin(newBase, base, base + old * pageBytes);
  view.fill(0, newBase + old * pageBytes, needed);
  base = newBase;
  g.base.value = base; g.pages.value = old + delta; g.bytes.value = BigInt((old + delta) * pageBytes);
  return old;
};
const instance = (await WebAssembly.instantiate(out, { __bl: { memory: engine, grow, base: g.base, bytes: g.bytes, pages: g.pages } })).instance;
const ex = instance.exports;
ex.__bl_init();
const results = [];
const same = (name, a, b) => { const ok = a === b; results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${a} / ${b}`); };
same('sum', ex.sum(), original.sum());
same('simd_sum', ex.simd_sum(), original.simd_sum());
const text = (mem, ptr) => new TextDecoder().decode(new Uint8Array(mem).slice(ptr, ptr + 17));
same('text', text(engine.buffer, base + ex.text_ptr()), text(original.memory.buffer, original.text_ptr()));
same('copy', ex.copy(5), original.copy(5));
same('atomic', ex.atomic(), original.atomic());
same('size', ex.size(), original.size());
same('grow', ex.grow(3), original.grow(3));
same('size nach grow', ex.size(), original.size());
same('sum nach grow (umgezogen)', ex.sum(), original.sum());
same('poke neue Seite', ex.poke(ex.size() - 1), original.poke(original.size() - 1));
let trapA = 'kein', trapB = 'kein';
try { ex.oob(); } catch (e) { trapA = e.constructor.name; }
try { original.oob(); } catch (e) { trapB = e.constructor.name; }
same('Zugriff ausserhalb faengt', trapA, trapB);
console.log(info.exports.map((e) => e.name).join(','), 'Speicher-Exporte:', info.memoryExports);
process.exit(results.every(Boolean) ? 0 : 1);
