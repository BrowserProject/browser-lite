// The C++ bridge (engine/src/wasm/WasmBridge.cpp) rebuilt in JS, so the host side (wasm-host.js)
// and the API (wasm-guest.js) run in node without the engine. The engine memory is a shared
// WebAssembly.Memory; memory.buffer is only a copy here (node has no alias).
// Like in C++: several realms (createRealm) that can only use their own memory, limits for memory
// and nesting, memory freed at 0 references, releases of the host side only at the next call,
// releaseRealm() like the teardown of the global object.
import fs from 'node:fs';
import vm from 'node:vm';

export const MAX_MEMORY_PAGES = 32768;
export const MAX_CALL_DEPTH = 64;

export function createBridgeSim() {
  const P = 65536;
  const SLOT = 16;
  const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
  const env = {
    wasmMemory,
    get HEAPU8() {
      return new Uint8Array(wasmMemory.buffer);
    },
    get HEAPU32() {
      return new Uint32Array(wasmMemory.buffer);
    },
    get HEAPF64() {
      return new Float64Array(wasmMemory.buffer);
    },
    UTF8ToString: (ptr, len) =>
      new TextDecoder().decode(new Uint8Array(wasmMemory.buffer).slice(ptr, ptr + len)),
    lengthBytesUTF8: (s) => new TextEncoder().encode(s).length,
    stringToUTF8: (s, ptr, max) => {
      const b = new TextEncoder().encode(s);
      new Uint8Array(wasmMemory.buffer).set(b.subarray(0, max - 1), ptr);
      new Uint8Array(wasmMemory.buffer)[ptr + b.length] = 0;
    },
    Module: {},
    WebAssembly,
    BigInt,
    FinalizationRegistry,
    WeakRef,
    JSON,
    Error,
    Map,
    TextDecoder,
    TextEncoder,
  };
  // Simple memory allocator (bump, free is ignored)
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
    vm.runInContext(
      fs.readFileSync(new URL('../../engine/js/' + file, import.meta.url), 'utf8') +
        '\nthis.' +
        (file === 'wasm-host.js' ? 'blWasmHost = blWasmHost' : 'blWasmRewrite = blWasmRewrite'),
      context,
    );
  const hostApi = context.blWasmHost;

  // ---- "C++": realms with their values from JSC by id, ids for realms and memories from a
  // counter
  let nextId = 1;
  const realms = new Map();
  let callDepth = 0;
  const u32 = () => new Uint32Array(wasmMemory.buffer);
  const f64 = () => new Float64Array(wasmMemory.buffer);

  function writePairs(ptr, pairs, realm) {
    const n = pairs.length / 2;
    for (let i = 0; i < n; i++) {
      const p = ptr + i * SLOT;
      const tag = pairs[2 * i],
        value = pairs[2 * i + 1];
      const U = u32();
      U[(p + 8) >> 2] = 0;
      U[(p + 12) >> 2] = 0;
      U[(p + 4) >> 2] = 0;
      switch (tag) {
        case 0:
        case 1:
          break;
        case 2:
          f64()[(p + 8) >> 3] = value;
          break;
        case 3: {
          const v = BigInt.asUintN(64, value);
          U[(p + 8) >> 2] = Number(v & 0xffffffffn);
          U[(p + 12) >> 2] = Number(v >> 32n);
          break;
        }
        case 4:
          U[(p + 8) >> 2] = value ? 1 : 0;
          break;
        case 5:
          U[(p + 4) >> 2] = realm.id;
          U[(p + 8) >> 2] = realm.register(value);
          break;
        case 6:
        case 8:
          U[(p + 8) >> 2] = value;
          break;
        case 9: {
          const ptr2 = malloc(value.length);
          new Uint8Array(wasmMemory.buffer).set(value, ptr2);
          U[(p + 8) >> 2] = ptr2;
          U[(p + 4) >> 2] = value.length;
          break;
        }
        case 10: {
          const b = new TextEncoder().encode(value);
          const ptr2 = malloc(b.length + 1);
          new Uint8Array(wasmMemory.buffer).set(b, ptr2);
          U[(p + 8) >> 2] = ptr2;
          U[(p + 4) >> 2] = b.length;
          break;
        }
        default:
          throw new Error('tag ' + tag);
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
      const tag = U[p >> 2],
        a = U[(p + 4) >> 2],
        lo = U[(p + 8) >> 2],
        hi = U[(p + 12) >> 2];
      const guests = tag === 5 || tag === 7 ? realms.get(a)?.guests : undefined;
      switch (tag) {
        case 0:
          pairs.push(0, undefined);
          break;
        case 1:
          pairs.push(1, null);
          break;
        case 2:
          pairs.push(2, f64()[(p + 8) >> 3]);
          break;
        case 3:
          pairs.push(3, BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo)));
          break;
        case 4:
          pairs.push(4, !!lo);
          break;
        case 5:
          pairs.push(5, guests?.get(lo));
          break;
        case 7:
          pairs.push(5, guests?.get(lo));
          guests?.delete(lo);
          break;
        case 6:
        case 8:
          pairs.push(tag, lo);
          break;
        case 10:
          pairs.push(
            10,
            new TextDecoder().decode(new Uint8Array(wasmMemory.buffer).slice(lo, lo + a)),
          );
          break;
        default:
          throw new Error('tag ' + tag);
      }
    }
    return pairs;
  }
  const CAP = 1024;
  const argsBuffer = malloc(CAP * SLOT),
    outBuffer = malloc(CAP * SLOT);
  env.Module._bl__wasm_call_guest = (realmId, id, args, n, out, cap) => {
    const realm = realms.get(realmId);
    const fn = realm && realm.guests.get(id);
    if (!fn) return 0;
    let result;
    try {
      if (callDepth >= MAX_CALL_DEPTH) throw new RangeError('Maximum call stack size exceeded.');
      callDepth++;
      try {
        result = fn(readPairs(args, n));
      } finally {
        callDepth--;
      }
    } catch (e) {
      result = [2, 1, 5, e];
    }
    return writePairs(out, result, realm);
  };
  env.Module._bl__wasm_release_guest = (realmId, id) => realms.get(realmId)?.released.push(id);

  // ---- Memories, like in C++ per thread with the realm that owns them
  const memories = new Map();
  function memoryCreate(realm, initial, maximum) {
    if (initial > MAX_MEMORY_PAGES)
      throw new RangeError('WebAssembly.Memory(): could not allocate memory');
    const id = nextId++;
    const base = malloc(Math.max(initial, 1) * P, P);
    memories.set(id, {
      realm,
      base,
      pages: initial,
      max: maximum < 0 ? MAX_MEMORY_PAGES : Math.min(maximum, MAX_MEMORY_PAGES),
      refs: 1,
    });
    hostApi.memoryCreate(id, realm, base, initial);
    return id;
  }
  function memoryGrow(id, delta) {
    const m = memories.get(id);
    if (!m || m.pages + delta > m.max) return -1;
    const old = m.pages;
    if (delta) {
      const base = malloc((old + delta) * P, P);
      const heap = new Uint8Array(wasmMemory.buffer);
      heap.copyWithin(base, m.base, m.base + old * P);
      heap.fill(0, base + old * P, base + (old + delta) * P);
      m.base = base;
      m.pages = old + delta;
      hostApi.memoryUpdate(id, base, m.pages);
    }
    return old;
  }
  function dropMemory(id) {
    hostApi.memoryUpdate(id, 0, -1);
    memories.delete(id);
  }
  function memoryRelease(id) {
    const m = memories.get(id);
    if (m && --m.refs <= 0) dropMemory(id);
  }
  env.Module._bl__wasm_memory_grow = memoryGrow;
  env.Module._bl__wasm_memory_retain = (id) => {
    const m = memories.get(id);
    if (m) m.refs++;
  };
  env.Module._bl__wasm_memory_release = memoryRelease;

  const guestSource = fs.readFileSync(
    new URL('../../engine/js/wasm-guest.js', import.meta.url),
    'utf8',
  );

  // New realm (global object): its own "WebAssembly" API over a bridge that, like in C++, only
  // accepts memories of its own realm
  function createRealm() {
    const id = nextId++;
    const guests = new Map();
    const released = [];
    let nextGuest = 1;
    const realm = {
      id,
      guests,
      released,
      register(value) {
        const guest = nextGuest++;
        guests.set(guest, value);
        return guest;
      },
    };
    realms.set(id, realm);
    const owned = (memoryId) => {
      const m = memories.get(memoryId);
      return m && m.realm === id ? m : undefined;
    };
    const bridge = {
      host(op, pairs) {
        for (const guest of released.splice(0)) guests.delete(guest);
        const n = writePairs(argsBuffer, pairs, realm);
        const count = hostApi.dispatch(id, op, argsBuffer, n, outBuffer, CAP);
        return readPairs(outBuffer, count);
      },
      memoryCreate: (initial, maximum) => memoryCreate(id, initial, maximum),
      // No alias possible in node: a copy
      memoryBuffer(memoryId) {
        const m = owned(memoryId);
        if (!m) throw new TypeError('WebAssembly.Memory: freigegeben');
        return new Uint8Array(wasmMemory.buffer).slice(m.base, m.base + m.pages * P).buffer;
      },
      memoryGrow(memoryId, delta) {
        if (!owned(memoryId)) throw new TypeError('WebAssembly.Memory: freigegeben');
        return memoryGrow(memoryId, delta);
      },
      memoryRelease(memoryId) {
        if (owned(memoryId)) memoryRelease(memoryId);
      },
    };
    return {
      realm: id,
      bridge,
      guests,
      WebAssembly: vm.runInThisContext(guestSource)(bridge),
      // Like the teardown of the global object of the realm
      releaseRealm() {
        for (const [memoryId, m] of [...memories]) if (m.realm === id) dropMemory(memoryId);
        guests.clear();
        realms.delete(id);
        hostApi.releaseRealm(id);
      },
    };
  }

  return { ...createRealm(), memories, createRealm };
}
