// Rewritten module (engine/js/wasm-rewrite.js) against the original: the same results, also
// after grow (the memory moves), with SIMD/atomics, several memories and memory64.
//   node tests/engine-js/rewrite-test.mjs [module.wasm]
import fs from 'node:fs';
import vm from 'node:vm';
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
vm.runInThisContext(
  fs.readFileSync(new URL('../../engine/js/wasm-rewrite.js', import.meta.url), 'utf8'),
);
const rewrite = globalThis.blWasmRewrite;

// "Engine": shared memory, one region per memory of the module from 1 MB on. grow always
// moves the region to the end
async function instantiateRewritten(bytes, imports = {}) {
  const engine = new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true });
  const { bytes: out, info } = rewrite(bytes);
  WebAssembly.validate(out) || console.log('INVALID');
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
      bytes: new WebAssembly.Global(
        { value: 'i64', mutable: true },
        BigInt(memory.min * pageBytes),
      ),
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
      g.base.value = region.base;
      g.pages.value = old + delta;
      g.bytes.value = BigInt((old + delta) * pageBytes);
      return old;
    };
    Object.assign(__bl, {
      ['grow' + k]: grow,
      ['base' + k]: g.base,
      ['bytes' + k]: g.bytes,
      ['pages' + k]: g.pages,
    });
    return region;
  });
  const instance = (await WebAssembly.instantiate(out, { ...imports, __bl })).instance;
  instance.exports.__bl_init();
  return { ex: instance.exports, info, engine, region: regions[0] };
}

const results = [];
const same = (name, a, b) => {
  const ok = a === b;
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${a} / ${b}`);
};
const trapName = (fn) => {
  try {
    fn();
    return 'none';
  } catch (e) {
    return e.constructor.name;
  }
};

// Test module (original against rewritten)
const bytes = fs.readFileSync(
  process.argv[2] || new URL('../fixtures/wasm/small.wasm', import.meta.url),
);
const original = (await WebAssembly.instantiate(bytes)).instance.exports;
const { ex, info, engine, region } = await instantiateRewritten(bytes);
same('sum', ex.sum(), original.sum());
same('simd_sum', ex.simd_sum(), original.simd_sum());
const text = (mem, ptr) => new TextDecoder().decode(new Uint8Array(mem).slice(ptr, ptr + 17));
same(
  'text',
  text(engine.buffer, region.base + ex.text_ptr()),
  text(original.memory.buffer, original.text_ptr()),
);
same('copy', ex.copy(5), original.copy(5));
same('atomic', ex.atomic(), original.atomic());
same('size', ex.size(), original.size());
same('grow', ex.grow(3), original.grow(3));
same('size after grow', ex.size(), original.size());
same('sum after grow (moved)', ex.sum(), original.sum());
same('poke new page', ex.poke(ex.size() - 1), original.poke(original.size() - 1));
same(
  'access outside traps',
  trapName(() => ex.oob()),
  trapName(() => original.oob()),
);
console.log(info.exports.map((e) => e.name + ':' + e.kind).join(','));

// Hand written modules: original and rewritten the same
async function both(name, module, run) {
  const native = (await WebAssembly.instantiate(module)).instance.exports;
  const rewritten = (await instantiateRewritten(module)).ex;
  same(name, run(rewritten), run(native));
}
const i32 = 0x7f;

// Table with an init expression (ref.func) and call_indirect: indices shifted
await both(
  'table with init expression',
  wasm(
    sec(1, [0x60, 0, 1, i32]),
    sec(3, [0], [0], [0]),
    sec(4, [0x40, 0x00, 0x70, 0x00, 1, 0xd2, 1, 0x0b]),
    sec(5, [0x00, 1]),
    sec(7, [...str('run'), 0, 2]),
    sec(10, code(0x41, 7), code(0x41, 42), code(0x41, 0, 0x11, 0, 0)),
  ),
  (e) => e.run(),
);

// memory.atomic.wait32/64 on unshared memory traps (does not wait)
const waitModule = wasm(
  sec(1, [0x60, 0, 1, i32]),
  sec(3, [0], [0]),
  sec(5, [0x00, 1]),
  sec(7, [...str('wait32'), 0, 0], [...str('wait64'), 0, 1]),
  sec(
    10,
    code(0x41, 0, 0x41, 0, 0x42, 0, 0xfe, 0x01, 2, 0),
    code(0x41, 0, 0x42, 0, 0x42, 0, 0xfe, 0x02, 3, 0),
  ),
);
await both('wait32 traps', waitModule, (e) => trapName(() => e.wait32()));
await both('wait64 traps', waitModule, (e) => trapName(() => e.wait64()));

// The start function already sees the data segments
await both(
  'start function after the data',
  wasm(
    sec(1, [0x60, 0, 0], [0x60, 0, 1, i32]),
    sec(3, [0], [1]),
    sec(5, [0x00, 1]),
    sec(6, [i32, 1, 0x41, 0, 0x0b]),
    sec(7, [...str('get'), 0, 1]),
    [8, 1, 0],
    sec(10, code(0x41, 0, 0x2d, 0, 0, 0x24, 0), code(0x23, 0)),
    sec(11, [0x00, 0x41, 0, 0x0b, 1, 65]),
  ),
  (e) => e.get(),
);

// Several memories and memory64 against the measured original (node 22 cannot do memory.copy
// between i32 and i64 memories yet)
async function expected(name, module, run, result) {
  same(name, run((await instantiateRewritten(module)).ex), result);
  const native = await WebAssembly.instantiate(module).catch(() => null);
  if (native) same(name + ' (original)', run(native.instance.exports), result);
}
await expected('several memories', multiMemoryModule(), multiMemoryRun, MULTI_MEMORY_RESULT);
await expected('memory64', memory64Module(), memory64Run, MEMORY64_RESULT);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
