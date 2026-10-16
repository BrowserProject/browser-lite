// WebAssembly der Seiten: die API "WebAssembly" fuer JavaScript in JSC.
//
// JSC kann mit dem C-Loop-Interpreter kein WebAssembly. Diese Datei baut die
// Standard-API nach und reicht die Arbeit ueber die C++-Bruecke
// (engine/src/wasm/WasmBridge.cpp) an die WASM-Engine des Browsers weiter
// (engine/js/wasm-host.js). Wird beim ersten Zugriff auf "WebAssembly"
// ausgewertet und mit der Bruecke aufgerufen:
//   bridge.host(op, paare) -> paare      Befehl an die Host-Seite
//   bridge.memoryCreate(seiten, max)     Speicher im Engine-Speicher -> id
//   bridge.memoryBuffer(id)              ArrayBuffer direkt auf den Speicher
//   bridge.memoryGrow(id, seiten)        -> alte Groesse oder -1
//   bridge.memoryRelease(id)             Memory-Objekt abgebaut
// Werte gehen als Paare [tag, wert, ...], siehe wasm-host.js.
(function (bridge) {
  'use strict';
  const { host, memoryCreate, memoryBuffer, memoryGrow, memoryRelease } = bridge;
  const internals = new WeakMap();
  const freeze = Object.freeze;
  const define = (object, name, value) => Object.defineProperty(object, name, { value, writable: true, configurable: true, enumerable: false });

  // ------------------------------------------------------------ Fehler

  function errorClass(name) {
    const Class = class extends Error {
      constructor(message) {
        super(message);
      }
    };
    Object.defineProperty(Class, 'name', { value: name });
    define(Class.prototype, 'name', name);
    return Class;
  }
  const CompileError = errorClass('CompileError');
  const LinkError = errorClass('LinkError');
  const RuntimeError = errorClass('RuntimeError');
  const errorClasses = { CompileError, LinkError, RuntimeError, TypeError, RangeError, Error, SyntaxError };

  // ------------------------------------------------------------ Werte

  // Wrapper fuer Objekte der Host-Seite, pro id genau einer
  const wrappers = new Map();
  const signatures = new Map();
  const finalizer = new FinalizationRegistry((id) => {
    const live = wrappers.get(id);
    if (live && live.deref())
      return;
    wrappers.delete(id);
    signatures.delete(id);
    host(18, [2, id]);
  });
  function cached(id, create) {
    const ref = wrappers.get(id);
    let wrapper = ref && ref.deref();
    if (!wrapper) {
      wrapper = create();
      wrappers.set(id, new WeakRef(wrapper));
      finalizer.register(wrapper, id);
    }
    return wrapper;
  }
  function opaque(id) {
    return cached(id, () => {
      const object = Object.create(null);
      internals.set(object, { kind: 'ref', id });
      return freeze(object);
    });
  }

  function encode(values) {
    const pairs = [];
    for (const value of values) {
      const inner = (typeof value === 'object' || typeof value === 'function') && value !== null ? internals.get(value) : undefined;
      if (value === undefined)
        pairs.push(0, 0);
      else if (value === null)
        pairs.push(1, 0);
      else if (typeof value === 'number')
        pairs.push(2, value);
      else if (typeof value === 'bigint')
        pairs.push(3, value);
      else if (typeof value === 'boolean')
        pairs.push(4, value);
      else if (inner && inner.id !== undefined)
        pairs.push(inner.kind === 'function' ? 8 : 6, inner.id);
      else if (value instanceof Bytes)
        pairs.push(9, value.bytes);
      else if (value instanceof Text)
        pairs.push(10, value.text);
      else
        pairs.push(5, value);
    }
    return pairs;
  }
  function decode(pairs) {
    const values = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const tag = pairs[i], value = pairs[i + 1];
      if (tag === 6)
        values.push(opaque(value));
      else if (tag === 8)
        values.push(exportedFunction(value));
      else
        values.push(value);
    }
    return values;
  }
  class Bytes {
    constructor(bytes) { this.bytes = bytes; }
  }
  class Text {
    constructor(text) { this.text = text; }
  }

  // Befehl ausfuehren, Fehler der Host-Seite als Fehler hier werfen
  function run(op, values) {
    const result = decode(host(op, encode(values)));
    const status = result[0];
    if (status === 0)
      return result.slice(1);
    if (status === 1)
      throw result[1];
    if (status === 3)
      throw exceptionFromHost(result[1]);
    const Class = errorClasses[result[1]] || Error;
    throw new Class(result[2]);
  }

  // Umwandlungen nach dem JS-API-Standard
  function toBigInt(value) {
    if (typeof value === 'number')
      throw new TypeError('Cannot convert a Number to a BigInt');
    return BigInt.asIntN(64, BigInt(value));
  }
  function toWasm(value, type) {
    switch (type) {
    case 'i32': return Number(value) | 0;
    case 'i64': return toBigInt(value);
    case 'f32': return Math.fround(Number(value));
    case 'f64': return Number(value);
    case 'v128': throw new TypeError('type incompatibility when transforming from/to JS');
    case 'funcref':
    case 'null ref':
      if (value === null)
        return null;
      if (typeof value === 'function' && internals.has(value) && internals.get(value).kind === 'function')
        return value;
      throw new TypeError('type incompatibility when transforming from/to JS');
    case 'externref':
      return value;
    default:
      return value;
    }
  }
  function convertArgs(signature, args) {
    if (!signature)
      return args;
    return signature.params.map((type, i) => toWasm(args[i], type));
  }
  function convertResults(signature, values) {
    if (!signature)
      return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
    if (signature.results.length === 0)
      return undefined;
    if (signature.results.length === 1)
      return values[0];
    return values;
  }

  // ------------------------------------------------------------ Funktionen

  function exportedFunction(id, signature, index) {
    if (signature) {
      signatures.set(id, signature);
      // Wrapper gibt es evtl. schon (ohne Signatur): Name und Laenge nachtragen
      const ref = wrappers.get(id);
      const existing = ref && ref.deref();
      if (existing) {
        Object.defineProperty(existing, 'length', { value: signature.params.length });
        if (index !== undefined)
          Object.defineProperty(existing, 'name', { value: String(index) });
        return existing;
      }
    }
    return cached(id, () => {
      const fn = (...args) => {
        const sig = signatures.get(id);
        return convertResults(sig, run(3, [fnRef(id), ...convertArgs(sig, args)]));
      };
      Object.defineProperty(fn, 'name', { value: String(index !== undefined ? index : id) });
      Object.defineProperty(fn, 'length', { value: signature ? signature.params.length : 0 });
      internals.set(fn, { kind: 'function', id });
      return fn;
    });
  }
  // Platzhalter fuer encode: eine Funktion der Host-Seite per id
  function fnRef(id) {
    const ref = Object.create(null);
    internals.set(ref, { kind: 'function', id });
    return ref;
  }

  // Funktion aus JS als Import: wird von C++ mit Paaren aufgerufen
  function importThunk(fn, signature) {
    return (pairs) => {
      try {
        const args = decode(pairs);
        const result = Reflect.apply(fn, undefined, signature ? args.slice(0, signature.params.length) : args);
        let values;
        if (!signature)
          values = result === undefined ? [] : [result];
        else if (signature.results.length === 0)
          values = [];
        else if (signature.results.length === 1)
          values = [toWasm(result, signature.results[0])];
        else {
          const list = [...result];
          if (list.length !== signature.results.length)
            throw new TypeError('multi-return length mismatch');
          values = list.map((v, i) => toWasm(v, signature.results[i]));
        }
        return encode([0, ...values]);
      } catch (e) {
        if (e instanceof Exception)
          return encode([3, e]);
        return [2, 1, 5, e];
      }
    };
  }

  // ------------------------------------------------------------ Speicher

  const memoryFinalizer = new FinalizationRegistry((id) => memoryRelease(id));
  function toIndex(value, what) {
    // Unaeres Plus ist ToNumber aus dem Standard: BigInt wirft TypeError
    const number = +value;
    if (!Number.isFinite(number) || number < 0 || number > 0xffffffff)
      throw new TypeError(what + ' must be convertible to a valid number');
    return Math.floor(number);
  }
  // Index oder Groesse fuer Speicher und Tabellen: bei address i64 (memory64,
  // table64) als BigInt, hier immer als Zahl (ueber 2^32 nie erfuellbar)
  function toAddress(value, address, what) {
    if (address === 'i32')
      return toIndex(value, what);
    if (typeof value === 'number')
      throw new TypeError('Cannot convert ' + value + ' to a BigInt');
    const big = BigInt(value);
    if (big < 0n || big > 0xffffffffffffffffn)
      throw new TypeError(what + ' must be convertible to a valid number');
    return big > 0xffffffffn ? 0xffffffff : Number(big);
  }
  const fromAddress = (value, address) => (address === 'i64' ? BigInt(value) : value);
  function addressType(descriptor, name) {
    const address = descriptor.address === undefined ? 'i32' : String(descriptor.address);
    if (address !== 'i32' && address !== 'i64')
      throw new TypeError('WebAssembly.' + name + '(): Property \'address\' must be \'i32\' or \'i64\'');
    return address;
  }
  class Memory {
    constructor(descriptor) {
      if (descriptor === null || typeof descriptor !== 'object')
        throw new TypeError('WebAssembly.Memory(): Argument 0 must be a memory descriptor');
      const address = addressType(descriptor, 'Memory');
      const initial = toAddress(descriptor.initial !== undefined ? descriptor.initial : descriptor.minimum, address, 'initial');
      const maximum = descriptor.maximum === undefined ? undefined : toAddress(descriptor.maximum, address, 'maximum');
      if (maximum !== undefined && maximum < initial)
        throw new RangeError('WebAssembly.Memory(): Property \'maximum\': value is below the lower bound');
      if (descriptor.shared)
        throw new TypeError('WebAssembly.Memory(): shared memory is not supported');
      // Grenzen wie in Chromium, die Engine hat eine eigene kleinere (WasmBridge.cpp)
      const bound = address === 'i64' ? 262144 : 65536;
      if (initial > bound || (maximum !== undefined && maximum > bound))
        throw new RangeError('WebAssembly.Memory(): Property \'initial\': value is above the upper bound');
      createMemory(this, { min: initial, max: maximum, address });
    }
    get buffer() {
      return memoryBuffer(memoryInner(this).memoryId);
    }
    grow(delta) {
      const { memoryId, address } = memoryInner(this);
      const old = memoryGrow(memoryId, toAddress(delta, address, 'delta'));
      if (old < 0)
        throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
      return fromAddress(old, address);
    }
  }
  function memoryInner(memory) {
    const inner = internals.get(memory);
    if (!inner || inner.kind !== 'memory')
      throw new TypeError('Receiver is not a WebAssembly.Memory');
    return inner;
  }
  const memoryId = (memory) => memoryInner(memory).memoryId;
  // Speicher im Engine-Speicher fuer ein neues Memory-Objekt. limits wie aus
  // blWasmRewrite (min, max, address), max kann bei memory64 sehr gross sein
  function createMemory(memory, limits) {
    const id = memoryCreate(limits.min, limits.max === undefined ? -1 : Math.min(limits.max, 65536));
    internals.set(memory, { kind: 'memory', memoryId: id, address: limits.address, maximum: limits.max });
    memoryFinalizer.register(memory, id);
    return memory;
  }

  // ------------------------------------------------------------ Tabellen, Globals, Tags

  // Objekt der Host-Seite mit bekanntem Typ (ersetzt einen untypisierten Wrapper)
  function hostObject(Class, kind, id, extra) {
    const ref = wrappers.get(id);
    const existing = ref && ref.deref();
    if (existing && internals.get(existing).kind === kind)
      return existing;
    const object = Object.create(Class.prototype);
    internals.set(object, { kind, id, ...extra });
    adopt(object, id);
    return object;
  }
  // Ein mit "new" erzeugtes Objekt wird der Wrapper fuer seine id
  function adopt(object, id) {
    wrappers.set(id, new WeakRef(object));
    finalizer.register(object, id);
  }
  function inner(object, kind, name) {
    const value = internals.get(object);
    if (!value || value.kind !== kind)
      throw new TypeError('Receiver is not a WebAssembly.' + name);
    return value;
  }

  class Table {
    constructor(descriptor, value) {
      if (descriptor === null || typeof descriptor !== 'object')
        throw new TypeError('WebAssembly.Table(): Argument 0 must be a table descriptor');
      const element = String(descriptor.element);
      const address = addressType(descriptor, 'Table');
      const initial = toAddress(descriptor.initial !== undefined ? descriptor.initial : descriptor.minimum, address, 'initial');
      const maximum = descriptor.maximum === undefined ? undefined : toAddress(descriptor.maximum, address, 'maximum');
      const type = element === 'anyfunc' ? 'funcref' : element;
      const args = [new Text(element), new Text(address), initial, maximum];
      if (arguments.length > 1)
        args.push(toWasm(value, type));
      const [table] = run(6, args);
      const id = internals.get(table).id;
      internals.set(this, { kind: 'table', id, type, address });
      adopt(this, id);
    }
    // Bei table64 gehen Index und Groesse als BigInt zur Host-Seite
    get length() {
      return run(10, [ref(this, 'table', 'Table')])[0];
    }
    get(index) {
      const table = inner(this, 'table', 'Table');
      return run(7, [ref(this, 'table', 'Table'), tableIndex(index, table, 'index')])[0];
    }
    set(index, value) {
      const table = inner(this, 'table', 'Table');
      const args = [ref(this, 'table', 'Table'), tableIndex(index, table, 'index')];
      if (arguments.length > 1)
        args.push(toWasm(value, table.type));
      run(8, args);
    }
    grow(delta, value) {
      const table = inner(this, 'table', 'Table');
      const args = [ref(this, 'table', 'Table'), tableIndex(delta, table, 'delta')];
      if (arguments.length > 1)
        args.push(toWasm(value, table.type));
      return run(9, args)[0];
    }
  }
  const tableIndex = (value, table, what) => fromAddress(toAddress(value, table.address, what), table.address);

  class Global {
    constructor(descriptor, value) {
      if (descriptor === null || typeof descriptor !== 'object')
        throw new TypeError('WebAssembly.Global(): Argument 0 must be a global descriptor');
      const type = String(descriptor.value);
      const mutable = !!descriptor.mutable;
      const args = [new Text(type), mutable];
      if (value !== undefined)
        args.push(toWasm(value, type));
      const [global] = run(11, args);
      const id = internals.get(global).id;
      internals.set(this, { kind: 'global', id, type, mutable });
      adopt(this, id);
    }
    get value() {
      return run(12, [ref(this, 'global', 'Global')])[0];
    }
    set value(value) {
      const global = inner(this, 'global', 'Global');
      if (!global.mutable)
        throw new TypeError('Can\'t set the value of an immutable global.');
      run(13, [ref(this, 'global', 'Global'), toWasm(value, global.type)]);
    }
    valueOf() {
      return this.value;
    }
  }

  class Tag {
    constructor(descriptor) {
      if (descriptor === null || typeof descriptor !== 'object')
        throw new TypeError('WebAssembly.Tag(): Argument 0 must be a tag type');
      const parameters = [...descriptor.parameters].map(String);
      const [tag] = run(14, [new Text(JSON.stringify(parameters))]);
      const id = internals.get(tag).id;
      internals.set(this, { kind: 'tag', id, parameters });
      adopt(this, id);
    }
  }

  class Exception {
    constructor(tag, payload) {
      const tagInner = inner(tag, 'tag', 'Tag');
      const values = [...payload];
      if (tagInner.parameters && values.length !== tagInner.parameters.length)
        throw new TypeError('WebAssembly.Exception(): Number of exception values does not match signature length');
      const converted = tagInner.parameters ? values.map((v, i) => toWasm(v, tagInner.parameters[i])) : values;
      const [exception] = run(15, [ref(tag, 'tag', 'Tag'), ...converted]);
      const id = internals.get(exception).id;
      internals.set(this, { kind: 'exception', id });
      adopt(this, id);
    }
    is(tag) {
      return run(16, [ref(this, 'exception', 'Exception'), ref(tag, 'tag', 'Tag')])[0];
    }
    getArg(tag, index) {
      return run(17, [ref(this, 'exception', 'Exception'), ref(tag, 'tag', 'Tag'), toIndex(index, 'index')])[0];
    }
  }
  function exceptionFromHost(object) {
    const id = internals.get(object).id;
    return hostObject(Exception, 'exception', id);
  }
  // Platzhalter fuer encode mit der id eines Objekts
  function ref(object, kind, name) {
    const value = inner(object, kind, name);
    const placeholder = Object.create(null);
    internals.set(placeholder, { kind, id: value.id });
    return placeholder;
  }

  // ------------------------------------------------------------ Module

  function toBytes(source) {
    if (source instanceof ArrayBuffer)
      return new Uint8Array(source.slice(0));
    if (ArrayBuffer.isView(source))
      return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    if (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer)
      return new Uint8Array(source.slice(0));
    throw new TypeError('WebAssembly.Module(): Argument 0 must be a buffer source');
  }

  class Module {
    constructor(source) {
      const bytes = toBytes(source);
      const [module, infoText] = run(1, [new Bytes(bytes)]);
      internals.set(this, { kind: 'module', id: internals.get(module).id, info: JSON.parse(infoText), bytes, keep: module });
    }
    static imports(module) {
      return inner(module, 'module', 'Module').info.imports.map((entry) => ({ module: entry.module, name: entry.name, kind: entry.kind }));
    }
    static exports(module) {
      return inner(module, 'module', 'Module').info.exports.map((entry) => ({ name: entry.name, kind: entry.kind }));
    }
    static customSections(module, sectionName) {
      const bytes = inner(module, 'module', 'Module').bytes;
      const wanted = String(sectionName);
      const result = [];
      let pos = 8;
      const u32 = () => {
        let value = 0, shift = 0, b;
        do {
          b = bytes[pos++];
          value += (b & 0x7f) * 2 ** shift;
          shift += 7;
        } while (b & 0x80);
        return value;
      };
      while (pos < bytes.length) {
        const id = bytes[pos++];
        const size = u32();
        const end = pos + size;
        if (id === 0) {
          const length = u32();
          const name = new TextDecoder().decode(bytes.subarray(pos, pos + length));
          if (name === wanted)
            result.push(bytes.slice(pos + length, end).buffer);
        }
        pos = end;
      }
      return result;
    }
  }

  class Instance {
    constructor(module, importObject) {
      const moduleInner = inner(module, 'module', 'Module');
      const info = moduleInner.info;
      if (info.imports.length && (importObject === undefined || importObject === null || typeof importObject !== 'object'))
        throw new TypeError('WebAssembly.Instance(): Imports argument must be present and must be an object');
      const imports = [];
      // Nach dem Index im Modul: erst importierte, dann eigene
      const memories = [];
      for (const entry of info.imports) {
        const namespace = importObject[entry.module];
        if (namespace === null || (typeof namespace !== 'object' && typeof namespace !== 'function'))
          throw new TypeError(`WebAssembly.Instance(): Import #${imports.length} "${entry.module}": module is not an object or function`);
        const value = namespace[entry.name];
        const where = `WebAssembly.Instance(): Import #${imports.length} "${entry.module}" "${entry.name}"`;
        switch (entry.kind) {
        case 'function':
          if (typeof value !== 'function')
            throw new LinkError(where + ': function import requires a callable');
          if (internals.has(value) && internals.get(value).kind === 'function')
            imports.push(value);
          else
            imports.push(importThunk(value, entry.signature));
          break;
        case 'memory': {
          const memory = internals.has(value) ? internals.get(value) : undefined;
          if (!memory || memory.kind !== 'memory')
            throw new LinkError(where + ': memory import must be a WebAssembly.Memory object');
          if (memory.address !== entry.memory.address)
            throw new LinkError(where + ': cannot import ' + memory.address + ' memory as ' + entry.memory.address);
          if (memoryBuffer(memory.memoryId).byteLength / 65536 < entry.memory.min)
            throw new LinkError(where + ': memory import is smaller than the module\'s declared initial size');
          if (entry.memory.max !== undefined && (memory.maximum === undefined || memory.maximum > entry.memory.max))
            throw new LinkError(where + ': memory import has a larger maximum size than the module\'s declared maximum');
          memories.push(value);
          imports.push(0);
          break;
        }
        case 'table':
          if (!(internals.has(value) && internals.get(value).kind === 'table'))
            throw new LinkError(where + ': table import requires a WebAssembly.Table');
          imports.push(value);
          break;
        case 'global':
          if (internals.has(value) && internals.get(value).kind === 'global')
            imports.push(value);
          else if (typeof value === 'number' || typeof value === 'bigint')
            imports.push(toWasm(value, entry.global.value));
          else
            throw new LinkError(where + ': global import must be a number, valid Wasm reference, or WebAssembly.Global object');
          break;
        case 'tag':
          if (!(internals.has(value) && internals.get(value).kind === 'tag'))
            throw new LinkError(where + ': tag import requires a WebAssembly.Tag');
          imports.push(value);
          break;
        }
      }
      for (const limits of info.memories) {
        if (!limits.imported)
          memories.push(createMemory(Object.create(Memory.prototype), limits));
      }
      const result = run(2, [ref(module, 'module', 'Module'), ...memories.map(memoryId), ...imports]);
      const exports = Object.create(null);
      let next = 1;
      for (const entry of info.exports) {
        if (entry.kind === 'memory') {
          exports[entry.name] = memories[entry.index];
          continue;
        }
        const value = result[next++];
        const id = internals.get(value).id;
        if (entry.kind === 'function')
          exports[entry.name] = exportedFunction(id, entry.signature, entry.index);
        else if (entry.kind === 'table')
          exports[entry.name] = hostObject(Table, 'table', id, { type: entry.table.element, address: entry.table.address });
        else if (entry.kind === 'global')
          exports[entry.name] = hostObject(Global, 'global', id, entry.global ? { type: entry.global.value, mutable: entry.global.mutable } : {});
        else if (entry.kind === 'tag')
          exports[entry.name] = hostObject(Tag, 'tag', id, {});
      }
      internals.set(this, { kind: 'instance', exports: freeze(exports), keep: result[0] });
    }
    get exports() {
      return inner(this, 'instance', 'Instance').exports;
    }
  }

  // ------------------------------------------------------------ Namensraum

  function later(work) {
    return new Promise((resolve) => resolve()).then(work);
  }
  async function responseBytes(source) {
    const response = await source;
    if (typeof Response === 'undefined' || !(response instanceof Response))
      throw new TypeError('WebAssembly.compileStreaming(): Argument 0 must be provided and must be a Response');
    const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/wasm')
      throw new TypeError('WebAssembly.compileStreaming(): Incorrect response MIME type. Expected \'application/wasm\'.');
    if (!response.ok)
      throw new TypeError('WebAssembly.compileStreaming(): HTTP status code is not ok');
    return response.arrayBuffer();
  }

  const WebAssembly = {
    validate(source) {
      return run(19, [new Bytes(toBytes(source))])[0];
    },
    compile(source) {
      let bytes;
      try {
        bytes = toBytes(source);
      } catch (e) {
        return Promise.reject(e);
      }
      return later(() => new Module(bytes));
    },
    instantiate(source, importObject) {
      if (internals.has(source) && internals.get(source).kind === 'module')
        return later(() => new Instance(source, importObject));
      let bytes;
      try {
        bytes = toBytes(source);
      } catch (e) {
        return Promise.reject(e);
      }
      return later(() => {
        const module = new Module(bytes);
        return { module, instance: new Instance(module, importObject) };
      });
    },
    compileStreaming(source) {
      return responseBytes(source).then((buffer) => new Module(buffer));
    },
    instantiateStreaming(source, importObject) {
      return responseBytes(source).then((buffer) => {
        const module = new Module(buffer);
        return { module, instance: new Instance(module, importObject) };
      });
    },
  };
  for (const [name, value] of Object.entries({ Module, Instance, Memory, Table, Global, Tag, Exception, CompileError, LinkError, RuntimeError })) {
    define(WebAssembly, name, value);
    Object.defineProperty(value.prototype, Symbol.toStringTag, { value: 'WebAssembly.' + name, configurable: true });
  }
  for (const name of ['validate', 'compile', 'instantiate', 'compileStreaming', 'instantiateStreaming'])
    Object.defineProperty(WebAssembly, name, { enumerable: false });
  Object.defineProperty(WebAssembly, Symbol.toStringTag, { value: 'WebAssembly', configurable: true });
  return WebAssembly;
})
