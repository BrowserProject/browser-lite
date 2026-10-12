// WebAssembly der Seiten, Host-Seite (laeuft im Engine-Worker, --pre-js).
//
// Die WebAssembly-API der Seite (engine/js/wasm-guest.js, laeuft in JSC)
// schickt ueber die C++-Bruecke (engine/src/wasm/WasmBridge.cpp) Befehle
// hierher. Module werden mit blWasmRewrite umgeschrieben und laufen in der
// echten WASM-Engine des Browsers, ihr Speicher liegt im Speicher der Engine.
//
// Werte gehen in "Slots" zu 16 Bytes ueber den Speicher der Engine:
//   u32 tag, u32 a, 8 Bytes Wert
// tag: 0 undefined, 1 null, 2 Zahl (f64), 3 BigInt (i64), 4 bool,
//      5 Wert aus JSC (id), 6 Objekt hier (id), 7 wie 5, danach freigeben,
//      8 Funktion hier (id),
//      9 Bytes (Zeiger, Laenge a), 10 Text (Zeiger, Laenge a, wird freigegeben)
// Das erste Ergebnis ist immer der Status: 0 ok, 1 Ausnahme aus JSC,
// 2 Fehler (Name, Text), 3 WebAssembly.Exception.

var blWasmHost = (function () {
  'use strict';
  const SLOT = 16;
  const PAGE = 65536;
  const CAP = 1024;

  // Objekte hier (Funktionen, Tabellen, Globals, Module, ...) bekommen eine id
  const hostRefs = new Map();
  const hostIds = new Map();
  let nextHostId = 1;
  function hostId(object) {
    let id = hostIds.get(object);
    if (id === undefined) {
      id = nextHostId++;
      hostIds.set(object, id);
      hostRefs.set(id, object);
    }
    return id;
  }
  function release(id) {
    const object = hostRefs.get(id);
    if (object !== undefined) {
      hostRefs.delete(id);
      hostIds.delete(object);
    }
  }

  // Werte aus JSC: ein Platzhalter pro id, solange er lebt
  class GuestRef {
    constructor(id) { this.id = id; }
  }
  // Ausnahme aus JSC, die durch WebAssembly-Code laeuft
  class GuestThrow {
    constructor(token) { this.token = token; }
  }
  const guestTokens = new Map();
  const registry = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry((id) => {
    const live = guestTokens.get(id);
    if (live && live.deref())
      return;
    guestTokens.delete(id);
    Module._bl_wasm_release_guest(id);
  }) : null;
  function guestToken(id) {
    const ref = guestTokens.get(id);
    let token = ref && ref.deref();
    if (!token) {
      token = new GuestRef(id);
      guestTokens.set(id, new WeakRef(token));
      if (registry)
        registry.register(token, id);
    }
    return token;
  }

  // ------------------------------------------------------------ Slots

  function read(ptr, count) {
    const values = [];
    for (let i = 0; i < count; i++) {
      const p = ptr + i * SLOT;
      const tag = HEAPU32[p >> 2];
      const a = HEAPU32[(p + 4) >> 2];
      const lo = HEAPU32[(p + 8) >> 2];
      const hi = HEAPU32[(p + 12) >> 2];
      switch (tag) {
      case 0: values.push(undefined); break;
      case 1: values.push(null); break;
      case 2: values.push(HEAPF64[(p + 8) >> 3]); break;
      case 3: values.push(BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo))); break;
      case 4: values.push(!!lo); break;
      case 5: case 7: values.push(guestToken(lo)); break;
      case 6: case 8: values.push(hostRefs.get(lo)); break;
      case 9: values.push(HEAPU8.slice(lo, lo + a)); break;
      case 10: values.push(UTF8ToString(lo, a)); break;
      default: throw new Error('unbekannter Slot ' + tag);
      }
    }
    return values;
  }

  function write(ptr, values) {
    if (values.length > CAP)
      throw new RangeError('zu viele Werte');
    for (let i = 0; i < values.length; i++) {
      const p = ptr + i * SLOT;
      const value = values[i];
      let tag, a = 0;
      HEAPU32[(p + 8) >> 2] = 0;
      HEAPU32[(p + 12) >> 2] = 0;
      if (value === undefined)
        tag = 0;
      else if (value === null)
        tag = 1;
      else if (typeof value === 'number') {
        tag = 2;
        HEAPF64[(p + 8) >> 3] = value;
      } else if (typeof value === 'bigint') {
        tag = 3;
        const v = BigInt.asUintN(64, value);
        HEAPU32[(p + 8) >> 2] = Number(v & 0xffffffffn);
        HEAPU32[(p + 12) >> 2] = Number(v >> 32n);
      } else if (typeof value === 'boolean') {
        tag = 4;
        HEAPU32[(p + 8) >> 2] = value ? 1 : 0;
      } else if (value instanceof GuestRef) {
        tag = 5;
        HEAPU32[(p + 8) >> 2] = value.id;
      } else if (value instanceof Text) {
        tag = 10;
        const length = lengthBytesUTF8(value.text);
        const buffer = Module._malloc(length + 1);
        stringToUTF8(value.text, buffer, length + 1);
        HEAPU32[(p + 8) >> 2] = buffer;
        a = length;
      } else if (value instanceof ReleaseGuest) {
        tag = 7;
        HEAPU32[(p + 8) >> 2] = value.token.id;
      } else {
        tag = typeof value === 'function' ? 8 : 6;
        HEAPU32[(p + 8) >> 2] = hostId(value);
      }
      HEAPU32[p >> 2] = tag;
      HEAPU32[(p + 4) >> 2] = a;
    }
    return values.length;
  }

  // Nur fuer write(): Text bzw. Wert aus JSC, der danach freigegeben wird
  class Text {
    constructor(text) { this.text = String(text); }
  }
  class ReleaseGuest {
    constructor(token) { this.token = token; }
  }

  function error(e) {
    if (e instanceof GuestThrow)
      return [1, new ReleaseGuest(e.token)];
    if (typeof WebAssembly.Exception !== 'undefined' && e instanceof WebAssembly.Exception)
      return [3, e];
    const name = e && e.name ? String(e.name) : 'Error';
    const message = e && e.message !== undefined ? String(e.message) : String(e);
    return [2, new Text(name), new Text(message)];
  }

  // ------------------------------------------------------------ Aufrufe in JSC

  let scratch = 0;
  function callGuest(token, args) {
    if (!scratch)
      scratch = Module._malloc(2 * CAP * SLOT);
    const count = write(scratch, args);
    const out = scratch + CAP * SLOT;
    const n = Module._bl_wasm_call_guest(token.id, scratch, count, out, CAP);
    const result = read(out, n);
    const status = result[0];
    if (status === 1)
      throw new GuestThrow(result[1]);
    if (status === 3)
      throw result[1];
    if (status !== 0)
      throw new Error(result[2] || 'Fehler in der Engine');
    const values = result.slice(1);
    return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
  }

  // ------------------------------------------------------------ Speicher

  // id -> { base, bytes, pages (Globals), grow }, verwaltet von C++
  const memories = new Map();
  function memoryCreate(id, base, pages) {
    memories.set(id, {
      base: new WebAssembly.Global({ value: 'i32', mutable: true }, base | 0),
      bytes: new WebAssembly.Global({ value: 'i64', mutable: true }, BigInt(pages) * BigInt(PAGE)),
      pages: new WebAssembly.Global({ value: 'i32', mutable: true }, pages),
      grow: (delta) => Module._bl_wasm_memory_grow(id, delta),
    });
    return [0];
  }
  function memoryUpdate(id, base, pages) {
    const memory = memories.get(id);
    if (!memory)
      return [0];
    memory.base.value = base | 0;
    memory.bytes.value = BigInt(pages) * BigInt(PAGE);
    memory.pages.value = pages;
    if (pages < 0) {
      // Freigegeben: jeder Zugriff faengt jetzt
      memory.bytes.value = 0n;
      memories.delete(id);
    }
    return [0];
  }

  // ------------------------------------------------------------ Module

  function compile(bytes) {
    let result;
    try {
      result = blWasmRewrite(bytes);
    } catch (e) {
      // Ungueltig? Dann die Meldung des Browsers
      if (!WebAssembly.validate(bytes)) {
        try {
          new WebAssembly.Module(bytes);
        } catch (compileError) {
          return error(compileError);
        }
      }
      return [2, new Text('CompileError'), new Text('browser-lite: ' + e.message)];
    }
    const module = new WebAssembly.Module(result.bytes);
    return [0, { module, info: result.info }, new Text(JSON.stringify(result.info))];
  }

  function instantiate(compiled, memoryId, imports) {
    const { module, info } = compiled;
    const object = {};
    info.imports.forEach((entry, i) => {
      if (entry.kind === 'memory')
        return;
      let value = imports[i];
      if (entry.kind === 'function' && value instanceof GuestRef) {
        const token = value;
        value = (...args) => callGuest(token, args);
      }
      (object[entry.module] || (object[entry.module] = {}))[entry.name] = value;
    });
    if (info.rewritten) {
      const memory = memories.get(memoryId);
      if (!memory)
        throw new Error('Speicher fehlt');
      object.__bl = { memory: wasmMemory, grow: memory.grow, base: memory.base, bytes: memory.bytes, pages: memory.pages };
    }
    const instance = new WebAssembly.Instance(module, object);
    if (info.rewritten)
      instance.exports.__bl_init();
    const exports = [];
    for (const entry of info.exports) {
      if (entry.kind !== 'memory')
        exports.push(instance.exports[entry.name]);
    }
    return [0, instance, ...exports];
  }

  function valueOf(results) {
    if (results === undefined)
      return [];
    if (Array.isArray(results))
      return results;
    return [results];
  }

  // ------------------------------------------------------------ Befehle

  const ops = {
    1: ([bytes]) => compile(bytes),
    2: ([compiled, memoryId, ...imports]) => instantiate(compiled, memoryId, imports),
    3: ([fn, ...args]) => [0, ...valueOf(fn(...args))],
    4: ([id, base, pages]) => memoryCreate(id, base, pages),
    5: ([id, base, pages]) => memoryUpdate(id, base, pages),
    6: ([element, initial, maximum, value]) => {
      const descriptor = { element, initial };
      if (maximum !== undefined)
        descriptor.maximum = maximum;
      return [0, value === undefined ? new WebAssembly.Table(descriptor) : new WebAssembly.Table(descriptor, value)];
    },
    7: ([table, index]) => [0, table.get(index)],
    8: ([table, index, value]) => (value === undefined ? table.set(index) : table.set(index, value), [0]),
    9: ([table, delta, value]) => [0, value === undefined ? table.grow(delta) : table.grow(delta, value)],
    10: ([table]) => [0, table.length],
    11: ([type, mutable, value]) => [0, value === undefined ? new WebAssembly.Global({ value: type, mutable }) : new WebAssembly.Global({ value: type, mutable }, value)],
    12: ([global]) => [0, global.value],
    13: ([global, value]) => (global.value = value, [0]),
    14: ([params]) => [0, new WebAssembly.Tag({ parameters: JSON.parse(params) })],
    15: ([tag, ...values]) => [0, new WebAssembly.Exception(tag, values)],
    16: ([exception, tag]) => [0, exception.is(tag)],
    17: ([exception, tag, index]) => [0, exception.getArg(tag, index)],
    18: ([id]) => (release(id), [0]),
    19: ([bytes]) => [0, WebAssembly.validate(bytes)],
    // Typ eines Globals/einer Tabelle (fuer die API der Seite)
    20: ([object]) => [0, new Text(object instanceof WebAssembly.Table ? 'table' : object instanceof WebAssembly.Global ? 'global' : typeof object)],
  };

  // Aufruf aus C++: Befehl ausfuehren, Ergebnis in out schreiben
  function dispatch(op, argsPtr, count, outPtr, cap) {
    let result;
    try {
      result = ops[op](read(argsPtr, count));
    } catch (e) {
      result = error(e);
    }
    if (result.length > cap)
      result = [2, new Text('RangeError'), new Text('zu viele Ergebnisse')];
    return write(outPtr, result);
  }

  return { dispatch, memoryCreate, memoryUpdate };
})();
