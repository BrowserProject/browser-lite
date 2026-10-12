// Die C++-Bruecke (engine/src/wasm/WasmBridge.cpp) in JS nachgebaut, damit
// die Host-Seite (wasm-host.js) und die API (wasm-guest.js) ohne Engine in
// node laufen. Der Speicher der Engine ist ein geteilter WebAssembly.Memory.
// memory.buffer ist hier nur eine Kopie (in node gibt es keinen Alias).
import fs from 'node:fs';
import vm from 'node:vm';

export function createWebAssembly() {
  const P = 65536;
  const SLOT = 16;
  const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
  const env = {
    wasmMemory,
    get HEAPU8() { return new Uint8Array(wasmMemory.buffer); },
    get HEAPU32() { return new Uint32Array(wasmMemory.buffer); },
    get HEAPF64() { return new Float64Array(wasmMemory.buffer); },
    UTF8ToString: (ptr, len) => new TextDecoder().decode(new Uint8Array(wasmMemory.buffer).slice(ptr, ptr + len)),
    lengthBytesUTF8: (s) => new TextEncoder().encode(s).length,
    stringToUTF8: (s, ptr, max) => { const b = new TextEncoder().encode(s); new Uint8Array(wasmMemory.buffer).set(b.subarray(0, max - 1), ptr); new Uint8Array(wasmMemory.buffer)[ptr + b.length] = 0; },
    Module: {},
    WebAssembly, BigInt, FinalizationRegistry, WeakRef, JSON, Error, Map, TextDecoder, TextEncoder,
  };
  // Einfacher Speicher-Verwalter (Bump, Freigabe wird ignoriert)
  let top = 1 << 20;
  const malloc = (size, align = 16) => {
    top = Math.ceil(top / align) * align;
    const ptr = top;
    top += size;
    if (top > wasmMemory.buffer.byteLength)
      wasmMemory.grow(Math.ceil((top - wasmMemory.buffer.byteLength) / P));
    return ptr;
  };
  env.Module._malloc = (size) => malloc(size);
  env.Module._free = () => {};
  const context = vm.createContext(env);
  for (const file of ['wasm-rewrite.js', 'wasm-host.js'])
    vm.runInContext(fs.readFileSync(new URL('../../engine/js/' + file, import.meta.url), 'utf8') + '\nthis.' + (file === 'wasm-host.js' ? 'blWasmHost = blWasmHost' : 'blWasmRewrite = blWasmRewrite'), context);
  const hostApi = context.blWasmHost;

  // ---- "C++": Werte aus JSC per id
  const guests = new Map();
  let nextGuest = 1;
  const register = (value) => { const id = nextGuest++; guests.set(id, value); return id; };
  const u32 = () => new Uint32Array(wasmMemory.buffer);
  const f64 = () => new Float64Array(wasmMemory.buffer);

  function writePairs(ptr, pairs) {
    const n = pairs.length / 2;
    for (let i = 0; i < n; i++) {
      const p = ptr + i * SLOT;
      const tag = pairs[2 * i], value = pairs[2 * i + 1];
      const U = u32();
      U[(p + 8) >> 2] = 0; U[(p + 12) >> 2] = 0; U[(p + 4) >> 2] = 0;
      switch (tag) {
      case 0: case 1: break;
      case 2: f64()[(p + 8) >> 3] = value; break;
      case 3: { const v = BigInt.asUintN(64, value); U[(p + 8) >> 2] = Number(v & 0xffffffffn); U[(p + 12) >> 2] = Number(v >> 32n); break; }
      case 4: U[(p + 8) >> 2] = value ? 1 : 0; break;
      case 5: U[(p + 8) >> 2] = register(value); break;
      case 6: case 8: U[(p + 8) >> 2] = value; break;
      case 9: { const ptr2 = malloc(value.length); new Uint8Array(wasmMemory.buffer).set(value, ptr2); U[(p + 8) >> 2] = ptr2; U[(p + 4) >> 2] = value.length; break; }
      case 10: { const b = new TextEncoder().encode(value); const ptr2 = malloc(b.length + 1); new Uint8Array(wasmMemory.buffer).set(b, ptr2); U[(p + 8) >> 2] = ptr2; U[(p + 4) >> 2] = b.length; break; }
      default: throw new Error('tag ' + tag);
      }
      U[p >> 2] = tag;
    }
    return n;
  }
  function readPairs(ptr, n) {
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const p = ptr + i * SLOT;
      const U = u32();
      const tag = U[p >> 2], a = U[(p + 4) >> 2], lo = U[(p + 8) >> 2], hi = U[(p + 12) >> 2];
      switch (tag) {
      case 0: pairs.push(0, undefined); break;
      case 1: pairs.push(1, null); break;
      case 2: pairs.push(2, f64()[(p + 8) >> 3]); break;
      case 3: pairs.push(3, BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo))); break;
      case 4: pairs.push(4, !!lo); break;
      case 5: pairs.push(5, guests.get(lo)); break;
      case 7: pairs.push(5, guests.get(lo)); guests.delete(lo); break;
      case 6: case 8: pairs.push(tag, lo); break;
      case 10: pairs.push(10, new TextDecoder().decode(new Uint8Array(wasmMemory.buffer).slice(lo, lo + a))); break;
      default: throw new Error('tag ' + tag);
      }
    }
    return pairs;
  }
  const CAP = 1024;
  const argsBuffer = malloc(CAP * SLOT), outBuffer = malloc(CAP * SLOT);
  function host(op, pairs) {
    const n = writePairs(argsBuffer, pairs);
    const count = hostApi.dispatch(op, argsBuffer, n, outBuffer, CAP);
    return readPairs(outBuffer, count);
  }
  env.Module._bl_wasm_call_guest = (id, args, n, out, cap) => {
    const fn = guests.get(id);
    let result;
    try {
      result = fn(readPairs(args, n));
    } catch (e) {
      result = [2, 1, 5, e];
    }
    return writePairs(out, result);
  };
  env.Module._bl_wasm_release_guest = (id) => guests.delete(id);

  // ---- Speicher
  const memories = new Map();
  let nextMemory = 1;
  function memoryCreate(initial, maximum) {
    const id = nextMemory++;
    const base = malloc(Math.max(initial, 1) * P, P);
    memories.set(id, { base, pages: initial, max: maximum < 0 ? 65536 : maximum, refs: 1, buffer: null });
    host(4, [2, id, 2, base, 2, initial]);
    return id;
  }
  function memoryGrow(id, delta) {
    const m = memories.get(id);
    if (!m || m.pages + delta > m.max)
      return -1;
    const old = m.pages;
    if (delta) {
      const base = malloc((old + delta) * P, P);
      const heap = new Uint8Array(wasmMemory.buffer);
      heap.copyWithin(base, m.base, m.base + old * P);
      heap.fill(0, base + old * P, base + (old + delta) * P);
      m.base = base;
      m.pages = old + delta;
      host(5, [2, id, 2, base, 2, m.pages]);
    }
    return old;
  }
  env.Module._bl_wasm_memory_grow = memoryGrow;
  const bridge = {
    host,
    memoryCreate,
    // In node kein Alias moeglich: Kopie
    memoryBuffer: (id) => { const m = memories.get(id); return new Uint8Array(wasmMemory.buffer).slice(m.base, m.base + m.pages * P).buffer; },
    memoryGrow,
    memoryRetain: (id) => memories.get(id).refs++,
    memoryRelease: (id) => memories.get(id).refs--,
  };
  const factory = vm.runInThisContext(fs.readFileSync(new URL('../../engine/js/wasm-guest.js', import.meta.url), 'utf8'));
  return factory(bridge);
}
