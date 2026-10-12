// WebAssembly der Seiten: Modul so umschreiben, dass sein Speicher ein Bereich
// im Speicher der Engine ist (siehe docs/architektur.md, "WebAssembly").
//
// Das Modul laeuft dann in der echten WASM-Engine des Browsers, JavaScript der
// Seite (in JSC) sieht den Speicher trotzdem direkt als ArrayBuffer. Dafuer:
// - Speicher 0 wird ein Import "__bl"."memory" (der Speicher der Engine)
// - jeder Zugriff bekommt eine Grenzpruefung gegen "__bl"."bytes" und die
//   Basis "__bl"."base" dazugezaehlt
// - memory.size liest "__bl"."pages", memory.grow ruft "__bl"."grow"
// - aktive Daten-Segmente werden passiv und von "__bl_init" geschrieben,
//   die auch die Start-Funktion aufruft
// Weil ein Funktions-Import und drei Globals dazukommen, verschieben sich die
// Indizes der eigenen Funktionen (+1) und Globals (+3).
//
// Laeuft in der Engine (--pre-js) und zum Testen in node.

var blWasmRewrite = (function () {
  'use strict';
  const SECTION = { custom: 0, type: 1, import: 2, func: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, elem: 9, code: 10, data: 11, datacount: 12, tag: 13 };
  // Reihenfolge der Sektionen im Modul (custom ausgenommen)
  const ORDER = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];

  class CompileError extends Error {}

  // ------------------------------------------------------------ Lesen

  class Reader {
    constructor(bytes, pos = 0, end = bytes.length) {
      this.bytes = bytes;
      this.pos = pos;
      this.end = end;
    }
    eof() { return this.pos >= this.end; }
    byte() {
      if (this.pos >= this.end)
        throw new CompileError('unerwartetes Ende');
      return this.bytes[this.pos++];
    }
    u32() {
      let result = 0, shift = 0, b;
      do {
        b = this.byte();
        result += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      return result;
    }
    // Vorzeichenbehaftet, nur ueberspringen (Wert wird nicht gebraucht)
    skipLeb() {
      while (this.byte() & 0x80) { }
    }
    s33() {
      let result = 0n, shift = 0n, b;
      do {
        b = this.byte();
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
      } while (b & 0x80);
      if (b & 0x40)
        result -= 1n << shift;
      return Number(result);
    }
    bytesN(n) {
      if (this.pos + n > this.end)
        throw new CompileError('unerwartetes Ende');
      const out = this.bytes.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }
    name() {
      return new TextDecoder().decode(this.bytesN(this.u32()));
    }
  }

  // ------------------------------------------------------------ Schreiben

  class Writer {
    constructor() {
      this.chunks = [];
      this.buffer = new Uint8Array(256);
      this.length = 0;
    }
    ensure(n) {
      if (this.length + n <= this.buffer.length)
        return;
      let size = this.buffer.length * 2;
      while (size < this.length + n)
        size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    byte(b) {
      this.ensure(1);
      this.buffer[this.length++] = b;
    }
    raw(bytes) {
      this.ensure(bytes.length);
      this.buffer.set(bytes, this.length);
      this.length += bytes.length;
    }
    u32(value) {
      do {
        let b = value % 128;
        value = Math.floor(value / 128);
        if (value)
          b |= 0x80;
        this.byte(b);
      } while (value);
    }
    s64(value) {
      value = BigInt(value);
      for (;;) {
        const b = Number(value & 0x7fn);
        value >>= 7n;
        if ((value === 0n && !(b & 0x40)) || (value === -1n && (b & 0x40))) {
          this.byte(b);
          return;
        }
        this.byte(b | 0x80);
      }
    }
    s32(value) { this.s64(value); }
    name(text) {
      const bytes = new TextEncoder().encode(text);
      this.u32(bytes.length);
      this.raw(bytes);
    }
    vec(items, writeItem) {
      this.u32(items.length);
      for (const item of items)
        writeItem(this, item);
    }
    bytes() { return this.buffer.subarray(0, this.length); }
  }

  // ------------------------------------------------------------ Typen

  const VALTYPE = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref',
    0x6e: 'anyref', 0x6d: 'eqref', 0x6c: 'i31ref', 0x6b: 'structref', 0x6a: 'arrayref', 0x71: 'nullref', 0x72: 'nullexternref',
    0x73: 'nullfuncref', 0x69: 'exnref', 0x74: 'nullexnref' };

  function readValType(r) {
    const b = r.byte();
    if (b === 0x63 || b === 0x64) {
      const heap = r.s33();
      // Abstrakte Heap-Typen haben negative Werte, eigene Typen den Index
      const name = heap >= 0 ? 'ref' : (VALTYPE[heap & 0x7f] || 'ref');
      return (b === 0x63 ? 'null ' : '') + name;
    }
    if (VALTYPE[b] === undefined)
      throw new CompileError('unbekannter Werttyp 0x' + b.toString(16));
    return VALTYPE[b];
  }

  function readStorageType(r) {
    const b = r.bytes[r.pos];
    if (b === 0x78 || b === 0x77) {
      r.pos++;
      return b === 0x78 ? 'i8' : 'i16';
    }
    return readValType(r);
  }

  function readCompType(r, types) {
    const form = r.byte();
    if (form === 0x60) {
      const params = [], results = [];
      for (let n = r.u32(); n; n--)
        params.push(readValType(r));
      for (let n = r.u32(); n; n--)
        results.push(readValType(r));
      types.push({ kind: 'func', params, results });
    } else if (form === 0x5f) {
      for (let n = r.u32(); n; n--) {
        readStorageType(r);
        r.byte();
      }
      types.push({ kind: 'struct' });
    } else if (form === 0x5e) {
      readStorageType(r);
      r.byte();
      types.push({ kind: 'array' });
    } else
      throw new CompileError('unbekannter Typ 0x' + form.toString(16));
  }

  function readSubType(r, types) {
    const b = r.bytes[r.pos];
    if (b === 0x50 || b === 0x4f) {
      r.pos++;
      for (let n = r.u32(); n; n--)
        r.u32();
    }
    readCompType(r, types);
  }

  function readTypeSection(r) {
    const types = [];
    for (let n = r.u32(); n; n--) {
      if (r.bytes[r.pos] === 0x4e) {
        r.pos++;
        for (let m = r.u32(); m; m--)
          readSubType(r, types);
      } else
        readSubType(r, types);
    }
    return types;
  }

  function readLimits(r) {
    const flags = r.byte();
    const limits = { min: r.u32(), shared: !!(flags & 2), memory64: !!(flags & 4) };
    if (flags & 1)
      limits.max = r.u32();
    if (flags & 4)
      throw new CompileError('memory64 wird nicht unterstuetzt');
    return limits;
  }

  function readTableType(r) {
    const element = readValType(r);
    return { element, ...readLimits(r) };
  }

  function readGlobalType(r) {
    return { value: readValType(r), mutable: r.byte() === 1 };
  }

  // ------------------------------------------------------------ Befehle
  //
  // Die Befehle werden nur so weit gelesen, dass man ihre Laenge kennt. Was
  // geaendert werden muss (Speicherzugriffe, Funktions- und Global-Indizes),
  // wird neu geschrieben, alles andere 1:1 kopiert.

  // Laden: Opcode -> Breite in Bytes
  const LOAD = { 0x28: 4, 0x29: 8, 0x2a: 4, 0x2b: 8, 0x2c: 1, 0x2d: 1, 0x2e: 2, 0x2f: 2, 0x30: 1, 0x31: 1, 0x32: 2, 0x33: 2, 0x34: 4, 0x35: 4 };
  // Speichern: Opcode -> [Breite, Werttyp]
  const STORE = { 0x36: [4, 'i32'], 0x37: [8, 'i64'], 0x38: [4, 'f32'], 0x39: [8, 'f64'], 0x3a: [1, 'i32'], 0x3b: [2, 'i32'],
    0x3c: [1, 'i64'], 0x3d: [2, 'i64'], 0x3e: [4, 'i64'] };
  // SIMD (0xFD): Laden/Speichern mit memarg -> [Breite, Wert-Operand, Lane-Byte]
  const SIMD_MEM = { 0: [16], 1: [8], 2: [8], 3: [8], 4: [8], 5: [8], 6: [8], 7: [1], 8: [2], 9: [4], 10: [8], 11: [16, 'v128'],
    84: [1, 'v128', 1], 85: [2, 'v128', 1], 86: [4, 'v128', 1], 87: [8, 'v128', 1],
    88: [1, 'v128', 1], 89: [2, 'v128', 1], 90: [4, 'v128', 1], 91: [8, 'v128', 1], 92: [4], 93: [8] };
  // Atomics (0xFE) Breiten und Typen der 7er-Gruppen
  const ATOMIC_WIDTH = [4, 8, 1, 2, 1, 2, 4];
  const ATOMIC_TYPE = ['i32', 'i64', 'i32', 'i32', 'i64', 'i64', 'i64'];

  // Temporaere Locals, die jede Funktion zusaetzlich bekommt. Die letzten zwei
  // halten Basis und Groesse des Speichers, damit nicht jeder Zugriff die
  // importierten Globals lesen muss (neu geladen nach jedem Aufruf, nur dort
  // kann der Speicher umziehen).
  const TEMPS = ['i32', 'i32', 'i32', 'i64', 'i64', 'f32', 'f64', 'v128', 'i32', 'i64'];

  // Abbruch, wenn eine Funktion try_table hat: dort werden Basis/Groesse nicht
  // zwischengespeichert (die Ziele der catch-Klauseln sind schwer zu finden)
  class NeedsGlobals extends Error {}
  const VALTYPE_CODE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b };

  function rewriteExpr(r, w, ctx, temps, cache = false) {
    // temps: Index des ersten Hilfs-Locals oder null (konstante Ausdruecke)
    const tA = temps, tB = temps + 1, tC = temps + 2, tL = temps + 3, tL2 = temps + 4, tF = temps + 5, tD = temps + 6, tV = temps + 7;
    const cBase = temps + 8, cBytes = temps + 9;
    const valueTemp = (type) => ({ i32: tB, i64: tL, f32: tF, f64: tD, v128: tV })[type];
    let depth = 1;
    const copyFrom = (start) => w.raw(r.bytes.subarray(start, r.pos));
    const getBase = () => {
      if (cache)
        w.byte(0x20), w.u32(cBase);
      else
        w.byte(0x23), w.u32(ctx.baseGlobal);
    };
    const getBytes = () => {
      if (cache)
        w.byte(0x20), w.u32(cBytes);
      else
        w.byte(0x23), w.u32(ctx.bytesGlobal);
    };
    const reload = () => {
      if (!cache)
        return;
      w.byte(0x23); w.u32(ctx.baseGlobal);
      w.byte(0x21); w.u32(cBase);
      w.byte(0x23); w.u32(ctx.bytesGlobal);
      w.byte(0x21); w.u32(cBytes);
    };
    reload();

    // Adresse oben auf dem Stack -> geprueft und mit Basis; "extra" = Offset + Breite
    const address = (extra) => {
      w.byte(0x22); w.u32(tA);
      w.byte(0xad);
      w.byte(0x42); w.s64(extra);
      w.byte(0x7c);
      getBytes();
      w.byte(0x56);
      w.byte(0x04); w.byte(0x40); w.byte(0x00); w.byte(0x0b);
      w.byte(0x20); w.u32(tA);
      getBase();
      w.byte(0x6a);
    };
    // Bereich [Local start, + Local length) muss im Speicher liegen
    const checkRange = (startLocal, lengthLocal) => {
      w.byte(0x20); w.u32(startLocal);
      w.byte(0xad);
      w.byte(0x20); w.u32(lengthLocal);
      w.byte(0xad);
      w.byte(0x7c);
      getBytes();
      w.byte(0x56);
      w.byte(0x04); w.byte(0x40); w.byte(0x00); w.byte(0x0b);
    };
    const withBase = (local) => {
      w.byte(0x20); w.u32(local);
      getBase();
      w.byte(0x6a);
    };
    const memarg = () => {
      const start = r.pos;
      const align = r.u32();
      if (align & 0x40)
        throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
      const offset = r.u32();
      return { bytes: r.bytes.subarray(start, r.pos), offset };
    };
    const needMemory = () => {
      if (temps === null || !ctx.hasMemory)
        throw new CompileError('Speicherzugriff ohne Speicher');
    };
    const funcIndex = () => {
      const index = r.u32();
      w.u32(index >= ctx.importedFuncs ? index + ctx.funcShift : index);
    };
    const globalIndex = () => {
      const index = r.u32();
      w.u32(index >= ctx.importedGlobals ? index + ctx.globalShift : index);
    };
    const blockType = () => {
      const b = r.bytes[r.pos];
      if (b === 0x40 || VALTYPE[b] !== undefined)
        r.pos++;
      else if (b === 0x63 || b === 0x64) {
        r.pos++;
        r.s33();
      } else
        r.s33();
    };

    while (depth > 0) {
      const start = r.pos;
      const op = r.byte();
      switch (op) {
      case 0x02: case 0x03: case 0x04: case 0x06:
        blockType();
        depth++;
        copyFrom(start);
        break;
      case 0x1f: { // try_table
        if (cache)
          throw new NeedsGlobals();
        blockType();
        for (let n = r.u32(); n; n--) {
          const kind = r.byte();
          if (kind === 0 || kind === 1)
            r.u32();
          r.u32();
        }
        depth++;
        copyFrom(start);
        break;
      }
      case 0x0b:
        depth--;
        copyFrom(start);
        break;
      case 0x18: // delegate beendet einen try-Block
        r.u32();
        depth--;
        copyFrom(start);
        break;
      case 0x07: // catch: der Handler beginnt hier
        r.u32();
        copyFrom(start);
        reload();
        break;
      case 0x19: // catch_all
        copyFrom(start);
        reload();
        break;
      case 0x14: // call_ref
        r.u32();
        copyFrom(start);
        reload();
        break;
      case 0x08: case 0x09: case 0x0c: case 0x0d: case 0x15:
      case 0x20: case 0x21: case 0x22: case 0x25: case 0x26: case 0xd5: case 0xd6:
        r.u32();
        copyFrom(start);
        break;
      case 0x0e:
        for (let n = r.u32() + 1; n; n--)
          r.u32();
        copyFrom(start);
        break;
      case 0x10:
        w.byte(op);
        funcIndex();
        reload();
        break;
      case 0x12: case 0xd2:
        w.byte(op);
        funcIndex();
        break;
      case 0x11: case 0x13:
        r.u32();
        r.u32();
        copyFrom(start);
        if (op === 0x11)
          reload();
        break;
      case 0x1c:
        for (let n = r.u32(); n; n--)
          readValType(r);
        copyFrom(start);
        break;
      case 0x23: case 0x24:
        w.byte(op);
        globalIndex();
        break;
      case 0x3f: // memory.size
        needMemory();
        if (r.byte() !== 0)
          throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
        w.byte(0x23); w.u32(ctx.pagesGlobal);
        break;
      case 0x40: // memory.grow
        needMemory();
        if (r.byte() !== 0)
          throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
        w.byte(0x10); w.u32(ctx.growFunc);
        reload();
        break;
      case 0x41: case 0x42:
        r.skipLeb();
        copyFrom(start);
        break;
      case 0x43:
        r.bytesN(4);
        copyFrom(start);
        break;
      case 0x44:
        r.bytesN(8);
        copyFrom(start);
        break;
      case 0xd0:
        r.s33();
        copyFrom(start);
        break;
      case 0xfb:
        gcOp(r, start);
        copyFrom(start);
        break;
      case 0xfc:
        miscOp(start);
        break;
      case 0xfd:
        simdOp(start);
        break;
      case 0xfe:
        atomicOp(start);
        break;
      default:
        if (LOAD[op] !== undefined) {
          needMemory();
          const arg = memarg();
          address(arg.offset + LOAD[op]);
          w.byte(op);
          w.raw(arg.bytes);
        } else if (STORE[op] !== undefined) {
          needMemory();
          const arg = memarg();
          const [width, type] = STORE[op];
          w.byte(0x21); w.u32(valueTemp(type));
          address(arg.offset + width);
          w.byte(0x20); w.u32(valueTemp(type));
          w.byte(op);
          w.raw(arg.bytes);
        } else if ((op >= 0x45 && op <= 0xc4) || op <= 0x01 || op === 0x05 || op === 0x0a || op === 0x0f
          || op === 0x1a || op === 0x1b || op === 0xd1 || op === 0xd3 || op === 0xd4)
          copyFrom(start);
        else
          throw new CompileError('unbekannter Befehl 0x' + op.toString(16));
      }
    }

    function miscOp(start) {
      const sub = r.u32();
      if (sub <= 7) {
        copyFrom(start);
        return;
      }
      switch (sub) {
      case 8: { // memory.init seg [d s n]
        needMemory();
        const segment = r.u32();
        r.byte();
        w.byte(0x21); w.u32(tC);
        w.byte(0x21); w.u32(tB);
        w.byte(0x21); w.u32(tA);
        checkRange(tA, tC);
        withBase(tA);
        w.byte(0x20); w.u32(tB);
        w.byte(0x20); w.u32(tC);
        w.byte(0xfc); w.u32(8); w.u32(segment); w.byte(0);
        return;
      }
      case 10: // memory.copy [d s n]
        needMemory();
        r.byte();
        r.byte();
        w.byte(0x21); w.u32(tC);
        w.byte(0x21); w.u32(tB);
        w.byte(0x21); w.u32(tA);
        checkRange(tA, tC);
        checkRange(tB, tC);
        withBase(tA);
        withBase(tB);
        w.byte(0x20); w.u32(tC);
        w.byte(0xfc); w.u32(10); w.byte(0); w.byte(0);
        return;
      case 11: // memory.fill [d val n]
        needMemory();
        r.byte();
        w.byte(0x21); w.u32(tC);
        w.byte(0x21); w.u32(tB);
        w.byte(0x21); w.u32(tA);
        checkRange(tA, tC);
        withBase(tA);
        w.byte(0x20); w.u32(tB);
        w.byte(0x20); w.u32(tC);
        w.byte(0xfc); w.u32(11); w.byte(0);
        return;
      case 9: case 13: case 15: case 16: case 17:
        r.u32();
        break;
      case 12: case 14:
        r.u32();
        r.u32();
        break;
      default:
        throw new CompileError('unbekannter Befehl 0xfc ' + sub);
      }
      copyFrom(start);
    }

    function simdOp(start) {
      const sub = r.u32();
      const mem = SIMD_MEM[sub];
      if (mem) {
        needMemory();
        const arg = memarg();
        const lane = mem[2] ? r.byte() : null;
        if (mem[1])
          w.byte(0x21), w.u32(tV);
        address(arg.offset + mem[0]);
        if (mem[1])
          w.byte(0x20), w.u32(tV);
        w.byte(0xfd); w.u32(sub);
        w.raw(arg.bytes);
        if (lane !== null)
          w.byte(lane);
        return;
      }
      if (sub === 12 || sub === 13)
        r.bytesN(16);
      else if (sub >= 21 && sub <= 34)
        r.byte();
      copyFrom(start);
    }

    function atomicOp(start) {
      const sub = r.u32();
      if (sub === 3) { // atomic.fence
        r.byte();
        copyFrom(start);
        return;
      }
      needMemory();
      const arg = memarg();
      const emit = () => {
        w.byte(0xfe); w.u32(sub);
        w.raw(arg.bytes);
      };
      if (sub === 0) { // notify [addr count]
        w.byte(0x21); w.u32(tB);
        address(arg.offset + 4);
        w.byte(0x20); w.u32(tB);
      } else if (sub === 1 || sub === 2) { // wait32/64 [addr expected timeout]
        const expected = sub === 1 ? tB : tL;
        w.byte(0x21); w.u32(tL2);
        w.byte(0x21); w.u32(expected);
        address(arg.offset + (sub === 1 ? 4 : 8));
        w.byte(0x20); w.u32(expected);
        w.byte(0x20); w.u32(tL2);
      } else if (sub >= 0x10 && sub <= 0x16) { // load
        address(arg.offset + ATOMIC_WIDTH[sub - 0x10]);
      } else if (sub >= 0x17 && sub <= 0x47) { // store und rmw [addr value]
        const variant = (sub - 0x17) % 7;
        const value = ATOMIC_TYPE[variant] === 'i32' ? tB : tL;
        w.byte(0x21); w.u32(value);
        address(arg.offset + ATOMIC_WIDTH[variant]);
        w.byte(0x20); w.u32(value);
      } else if (sub >= 0x48 && sub <= 0x4e) { // cmpxchg [addr expected replacement]
        const variant = sub - 0x48;
        const [first, second] = ATOMIC_TYPE[variant] === 'i32' ? [tB, tC] : [tL, tL2];
        w.byte(0x21); w.u32(second);
        w.byte(0x21); w.u32(first);
        address(arg.offset + ATOMIC_WIDTH[variant]);
        w.byte(0x20); w.u32(first);
        w.byte(0x20); w.u32(second);
      } else
        throw new CompileError('unbekannter Befehl 0xfe ' + sub);
      emit();
    }
  }

  function gcOp(r) {
    const sub = r.u32();
    const heapType = () => r.s33();
    switch (sub) {
    case 0: case 1: case 6: case 7: case 11: case 12: case 13: case 14: case 16:
      r.u32();
      break;
    case 2: case 3: case 4: case 5: case 8: case 9: case 10: case 17: case 18: case 19:
      r.u32();
      r.u32();
      break;
    case 15: case 26: case 27: case 28: case 29: case 30:
      break;
    case 20: case 21: case 22: case 23:
      heapType();
      break;
    case 24: case 25:
      r.byte();
      r.u32();
      heapType();
      heapType();
      break;
    default:
      throw new CompileError('unbekannter Befehl 0xfb ' + sub);
    }
  }

  // Konstanter Ausdruck (Globals, Segmente): nur Indizes umschreiben
  function rewriteConstExpr(r, ctx) {
    const w = new Writer();
    rewriteExpr(r, w, ctx, null);
    return w.bytes().slice();
  }

  // ------------------------------------------------------------ Modul

  function parseModule(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
      throw new CompileError('kein WebAssembly-Modul');
    if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0)
      throw new CompileError('unbekannte Version');
    const sections = [];
    const r = new Reader(bytes, 8);
    while (!r.eof()) {
      const id = r.byte();
      const size = r.u32();
      const start = r.pos;
      if (start + size > bytes.length)
        throw new CompileError('Sektion zu lang');
      sections.push({ id, body: bytes.subarray(start, start + size) });
      r.pos = start + size;
    }
    return sections;
  }

  function rewrite(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const sections = parseModule(bytes);
    const find = (id) => sections.find((s) => s.id === id);

    // Typen, Importe und Speicher lesen
    const types = find(SECTION.type) ? readTypeSection(new Reader(find(SECTION.type).body)) : [];
    const imports = [];
    let importedFuncs = 0, importedGlobals = 0, importedTables = 0, importedTags = 0;
    let memory = null;
    if (find(SECTION.import)) {
      const r = new Reader(find(SECTION.import).body);
      for (let n = r.u32(); n; n--) {
        const entry = { module: r.name(), name: r.name(), kind: r.byte() };
        if (entry.kind === 0) {
          entry.type = r.u32();
          importedFuncs++;
        } else if (entry.kind === 1) {
          entry.table = readTableType(r);
          importedTables++;
        } else if (entry.kind === 2) {
          if (memory)
            throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
          entry.memory = readLimits(r);
          memory = { ...entry.memory, imported: true, module: entry.module, name: entry.name };
        } else if (entry.kind === 3) {
          entry.global = readGlobalType(r);
          importedGlobals++;
        } else if (entry.kind === 4) {
          r.byte();
          entry.type = r.u32();
          importedTags++;
        } else
          throw new CompileError('unbekannter Import');
        imports.push(entry);
      }
    }
    if (find(SECTION.memory)) {
      const r = new Reader(find(SECTION.memory).body);
      const count = r.u32();
      if (count + (memory ? 1 : 0) > 1)
        throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
      if (count)
        memory = { ...readLimits(r), imported: false };
    }
    const funcTypes = [];
    if (find(SECTION.func)) {
      const r = new Reader(find(SECTION.func).body);
      for (let n = r.u32(); n; n--)
        funcTypes.push(r.u32());
    }
    // Typen der eigenen Tabellen und Globals (fuer die Exporte)
    const tableTypes = imports.filter((i) => i.kind === 1).map((i) => i.table);
    if (find(SECTION.table)) {
      const r = new Reader(find(SECTION.table).body);
      for (let n = r.u32(); n; n--) {
        if (r.bytes[r.pos] === 0x40) {
          // Tabelle mit Init-Ausdruck
          r.pos += 2;
          tableTypes.push(readTableType(r));
          rewriteExpr(r, new Writer(), { importedFuncs: 0, importedGlobals: 0, funcShift: 0, globalShift: 0 }, null);
        } else
          tableTypes.push(readTableType(r));
      }
    }
    const globalTypes = imports.filter((i) => i.kind === 3).map((i) => i.global);
    if (find(SECTION.global)) {
      const r = new Reader(find(SECTION.global).body);
      for (let n = r.u32(); n; n--) {
        globalTypes.push(readGlobalType(r));
        rewriteExpr(r, new Writer(), { importedFuncs: 0, importedGlobals: 0, funcShift: 0, globalShift: 0 }, null);
      }
    }
    const exportsList = [];
    if (find(SECTION.export)) {
      const r = new Reader(find(SECTION.export).body);
      for (let n = r.u32(); n; n--)
        exportsList.push({ name: r.name(), kind: r.byte(), index: r.u32() });
    }

    const funcSignature = (index) => {
      const typeIndex = index < importedFuncs ? imports.filter((i) => i.kind === 0)[index].type : funcTypes[index - importedFuncs];
      const type = types[typeIndex];
      if (!type || type.kind !== 'func')
        throw new CompileError('Funktion ohne Funktionstyp');
      return type;
    };
    const signatureOf = (typeIndex) => {
      const type = types[typeIndex];
      return type && type.kind === 'func' ? { params: type.params, results: type.results } : null;
    };

    // Beschreibung fuer die WebAssembly-API der Seite
    const info = {
      imports: imports.map((entry) => {
        const out = { module: entry.module, name: entry.name, kind: ['function', 'table', 'memory', 'global', 'tag'][entry.kind] };
        if (entry.kind === 0 || entry.kind === 4)
          out.signature = signatureOf(entry.type);
        if (entry.kind === 1)
          out.table = entry.table;
        if (entry.kind === 2)
          out.memory = entry.memory;
        if (entry.kind === 3)
          out.global = entry.global;
        return out;
      }),
      exports: exportsList.map((entry) => {
        const out = { name: entry.name, kind: ['function', 'table', 'memory', 'global', 'tag'][entry.kind] };
        if (entry.kind === 0) {
          out.signature = { params: funcSignature(entry.index).params, results: funcSignature(entry.index).results };
          out.index = entry.index;
        }
        if (entry.kind === 1)
          out.table = tableTypes[entry.index];
        if (entry.kind === 3)
          out.global = globalTypes[entry.index];
        return out;
      }),
      memory,
      rewritten: false,
    };

    if (!memory)
      return { bytes, info };
    if (memory.shared)
      throw new CompileError('geteilter Speicher (Threads) wird nicht unterstuetzt');

    // Neue Typen, Importe, Indizes
    const typeCount = types.length;
    const growType = typeCount, initType = typeCount + 1;
    const ctx = {
      hasMemory: true,
      importedFuncs,
      importedGlobals,
      funcShift: 1,
      globalShift: 3,
      growFunc: importedFuncs,
      baseGlobal: importedGlobals,
      bytesGlobal: importedGlobals + 1,
      pagesGlobal: importedGlobals + 2,
    };
    const definedFuncs = funcTypes.length;
    const initFunc = importedFuncs + 1 + definedFuncs;

    const out = new Writer();
    out.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const emitSection = (id, body) => {
      out.byte(id);
      out.u32(body.length);
      out.raw(body);
    };

    let startFunc = null;
    if (find(SECTION.start))
      startFunc = new Reader(find(SECTION.start).body).u32();
    const activeData = [];
    let dataCount = 0;
    let hasDataCount = !!find(SECTION.datacount);

    // Neu geschriebene Sektionen nach id
    const built = new Map();

    // Typen: zwei Funktionstypen anhaengen
    {
      const w = new Writer();
      const old = find(SECTION.type);
      let rest = new Uint8Array(0), count = 0;
      if (old) {
        const r = new Reader(old.body);
        count = r.u32();
        rest = old.body.subarray(r.pos);
      }
      w.u32(count + 2);
      w.raw(rest);
      w.raw([0x60, 1, 0x7f, 1, 0x7f]);
      w.raw([0x60, 0, 0]);
      built.set(SECTION.type, w.bytes().slice());
    }

    // Importe: Speicher ersetzen bzw. dazu, dann grow und die drei Globals
    {
      const w = new Writer();
      const entries = [];
      const old = find(SECTION.import);
      if (old) {
        const r = new Reader(old.body);
        for (let n = r.u32(); n; n--) {
          const start = r.pos;
          r.name();
          r.name();
          const kind = r.byte();
          if (kind === 0) r.u32();
          else if (kind === 1) readTableType(r);
          else if (kind === 2) readLimits(r);
          else if (kind === 3) readGlobalType(r);
          else { r.byte(); r.u32(); }
          entries.push(kind === 2 ? 'memory' : old.body.subarray(start, r.pos));
        }
      }
      if (!memory.imported)
        entries.push('memory');
      const memoryImport = new Writer();
      memoryImport.name('__bl');
      memoryImport.name('memory');
      memoryImport.raw([0x02, 0x03, 0x01]);
      memoryImport.u32(65536);
      w.u32(entries.length + 4);
      for (const entry of entries)
        w.raw(entry === 'memory' ? memoryImport.bytes() : entry);
      w.name('__bl'); w.name('grow'); w.byte(0x00); w.u32(growType);
      w.name('__bl'); w.name('base'); w.byte(0x03); w.byte(0x7f); w.byte(0x01);
      w.name('__bl'); w.name('bytes'); w.byte(0x03); w.byte(0x7e); w.byte(0x01);
      w.name('__bl'); w.name('pages'); w.byte(0x03); w.byte(0x7f); w.byte(0x01);
      built.set(SECTION.import, w.bytes().slice());
    }

    // Funktionen: Init-Funktion dazu
    {
      const w = new Writer();
      w.u32(definedFuncs + 1);
      for (const type of funcTypes)
        w.u32(type);
      w.u32(initType);
      built.set(SECTION.func, w.bytes().slice());
    }

    // Globals: Init-Ausdruecke umschreiben
    if (find(SECTION.global)) {
      const r = new Reader(find(SECTION.global).body);
      const w = new Writer();
      const count = r.u32();
      w.u32(count);
      for (let n = count; n; n--) {
        const start = r.pos;
        readGlobalType(r);
        w.raw(r.bytes.subarray(start, r.pos));
        w.raw(rewriteConstExpr(r, ctx));
      }
      built.set(SECTION.global, w.bytes().slice());
    }

    // Exporte: Speicher raus (kommt von der API), Indizes, __bl_init dazu
    {
      const w = new Writer();
      const kept = exportsList.filter((e) => e.kind !== 2);
      info.memoryExports = exportsList.filter((e) => e.kind === 2).map((e) => e.name);
      w.u32(kept.length + 1);
      for (const entry of kept) {
        w.name(entry.name);
        w.byte(entry.kind);
        let index = entry.index;
        if (entry.kind === 0 && index >= importedFuncs)
          index += ctx.funcShift;
        if (entry.kind === 3 && index >= importedGlobals)
          index += ctx.globalShift;
        w.u32(index);
      }
      w.name('__bl_init');
      w.byte(0x00);
      w.u32(initFunc);
      built.set(SECTION.export, w.bytes().slice());
    }

    // Elemente: Funktions-Indizes und Ausdruecke
    if (find(SECTION.elem)) {
      const r = new Reader(find(SECTION.elem).body);
      const w = new Writer();
      const count = r.u32();
      w.u32(count);
      for (let n = count; n; n--) {
        const flags = r.u32();
        w.u32(flags);
        if (flags & 2 && !(flags & 1))
          w.u32(r.u32());
        if (!(flags & 1))
          w.raw(rewriteConstExpr(r, ctx));
        if (flags & 3) {
          const start = r.pos;
          if (flags & 4)
            readValType(r);
          else
            r.byte();
          w.raw(r.bytes.subarray(start, r.pos));
        }
        const items = r.u32();
        w.u32(items);
        for (let i = 0; i < items; i++) {
          if (flags & 4)
            w.raw(rewriteConstExpr(r, ctx));
          else {
            const index = r.u32();
            w.u32(index >= importedFuncs ? index + ctx.funcShift : index);
          }
        }
      }
      built.set(SECTION.elem, w.bytes().slice());
    }

    // Daten: aktive Segmente werden passiv
    if (find(SECTION.data)) {
      const r = new Reader(find(SECTION.data).body);
      const w = new Writer();
      dataCount = r.u32();
      w.u32(dataCount);
      for (let i = 0; i < dataCount; i++) {
        const flags = r.u32();
        if (flags === 1) {
          w.u32(1);
        } else {
          if (flags === 2 && r.u32() !== 0)
            throw new CompileError('mehrere Speicher werden nicht unterstuetzt');
          activeData.push({ index: i, offset: rewriteConstExpr(r, ctx) });
          w.u32(1);
        }
        const length = r.u32();
        if (activeData.length && activeData[activeData.length - 1].index === i)
          activeData[activeData.length - 1].length = length;
        w.u32(length);
        w.raw(r.bytesN(length));
      }
      built.set(SECTION.data, w.bytes().slice());
    }
    if (activeData.length && !hasDataCount) {
      const w = new Writer();
      w.u32(dataCount);
      built.set(SECTION.datacount, w.bytes().slice());
      hasDataCount = true;
    }

    // Code: Speicherzugriffe umschreiben, Hilfs-Locals dazu, Init-Funktion anhaengen
    {
      const w = new Writer();
      const old = find(SECTION.code);
      const r = old ? new Reader(old.body) : null;
      const count = r ? r.u32() : 0;
      if (count !== definedFuncs)
        throw new CompileError('Code und Funktionen passen nicht');
      w.u32(count + 1);
      for (let i = 0; i < count; i++) {
        const size = r.u32();
        const end = r.pos + size;
        const body = new Reader(r.bytes, r.pos, end);
        const params = types[funcTypes[i]].params.length;
        const groups = [];
        let locals = 0;
        for (let n = body.u32(); n; n--) {
          const howMany = body.u32();
          const start = body.pos;
          readValType(body);
          groups.push([howMany, body.bytes.subarray(start, body.pos)]);
          locals += howMany;
        }
        const f = new Writer();
        f.u32(groups.length + TEMPS.length);
        for (const [howMany, type] of groups) {
          f.u32(howMany);
          f.raw(type);
        }
        for (const type of TEMPS) {
          f.u32(1);
          f.byte(VALTYPE_CODE[type]);
        }
        const bodyStart = body.pos;
        const header = f.length;
        try {
          rewriteExpr(body, f, ctx, params + locals, true);
        } catch (e) {
          if (!(e instanceof NeedsGlobals))
            throw e;
          f.length = header;
          body.pos = bodyStart;
          rewriteExpr(body, f, ctx, params + locals, false);
        }
        if (body.pos !== end)
          throw new CompileError('Funktion endet nicht richtig');
        w.u32(f.length);
        w.raw(f.bytes());
        r.pos = end;
      }
      // __bl_init: Daten schreiben, dann die Start-Funktion
      const f = new Writer();
      f.u32(1);
      f.u32(1);
      f.byte(0x7f);
      for (const segment of activeData) {
        f.raw(segment.offset.subarray(0, segment.offset.length - 1));
        f.byte(0x21); f.u32(0);
        f.byte(0x20); f.u32(0);
        f.byte(0xad);
        f.byte(0x42); f.s64(segment.length);
        f.byte(0x7c);
        f.byte(0x23); f.u32(ctx.bytesGlobal);
        f.byte(0x56);
        f.byte(0x04); f.byte(0x40); f.byte(0x00); f.byte(0x0b);
        f.byte(0x20); f.u32(0);
        f.byte(0x23); f.u32(ctx.baseGlobal);
        f.byte(0x6a);
        f.byte(0x41); f.s32(0);
        f.byte(0x41); f.s32(segment.length);
        f.byte(0xfc); f.u32(8); f.u32(segment.index); f.byte(0);
        f.byte(0xfc); f.u32(9); f.u32(segment.index);
      }
      if (startFunc !== null) {
        f.byte(0x10);
        f.u32(startFunc >= importedFuncs ? startFunc + ctx.funcShift : startFunc);
      }
      f.byte(0x0b);
      w.u32(f.length);
      w.raw(f.bytes());
      built.set(SECTION.code, w.bytes().slice());
    }

    // Alles in der richtigen Reihenfolge zusammensetzen
    const skip = new Set([SECTION.memory, SECTION.start]);
    const written = new Set();
    const writeKnown = (id) => {
      if (written.has(id) || skip.has(id))
        return;
      written.add(id);
      if (built.has(id))
        emitSection(id, built.get(id));
      else if (find(id))
        emitSection(id, find(id).body);
    };
    for (const section of sections) {
      if (section.id === SECTION.custom) {
        // Namen passen nach dem Verschieben nicht mehr
        const r = new Reader(section.body);
        if (r.name() !== 'name')
          emitSection(SECTION.custom, section.body);
        continue;
      }
      // Fehlende neue Sektionen vor dieser einfuegen
      for (const id of ORDER) {
        if (id === section.id)
          break;
        if (built.has(id) && !find(id))
          writeKnown(id);
      }
      writeKnown(section.id);
    }
    for (const id of ORDER)
      if (built.has(id))
        writeKnown(id);

    info.rewritten = true;
    return { bytes: out.bytes().slice(), info };
  }

  rewrite.CompileError = CompileError;
  return rewrite;
})();

