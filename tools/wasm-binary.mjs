// Reading and small edits of WebAssembly binaries for the build tools (optimize-assets.mjs,
// split-engine.mjs): sections, function names, imports with their types, exports.

/** Unsigned LEB128 at `offset`: [value, offset after it]. */
export function readLEB(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (offset >= bytes.length) throw new Error('WebAssembly module is truncated');
    const byte = bytes[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, offset];
  }
}

/** Unsigned LEB128 of `value`. */
export function encodeLEB(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return Buffer.from(out);
}

/** Every section: id, name (custom sections only), start, payload start and end. */
export function* wasmSections(bytes) {
  let offset = 8;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const [size, payload] = readLEB(bytes, offset);
    const end = payload + size;
    if (end > bytes.length) throw new Error('WebAssembly module is truncated');
    let name;
    if (id === 0) {
      const [nameLength, nameStart] = readLEB(bytes, payload);
      name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    }
    yield { id, name, start, payload, end };
    offset = end;
  }
}

function readString(bytes, offset) {
  const [length, start] = readLEB(bytes, offset);
  return [bytes.subarray(start, start + length).toString(), start + length];
}

function readLimits(bytes, offset) {
  const flags = bytes[offset++];
  let min;
  let max;
  [min, offset] = readLEB(bytes, offset);
  if (flags & 1) [max, offset] = readLEB(bytes, offset);
  return [{ min, max, shared: !!(flags & 2) }, offset];
}

const VALUE_TYPES = {
  127: 'i32',
  126: 'i64',
  125: 'f32',
  124: 'f64',
  123: 'v128',
  112: 'funcref',
  111: 'externref',
};

function valueType(byte) {
  const type = VALUE_TYPES[byte];
  if (!type) throw new Error(`Unsupported value type 0x${byte.toString(16)}`);
  return type;
}

/** Function types of the type section: [{ params, results }] (only plain function types). */
export function functionTypes(bytes) {
  const types = [];
  for (const section of wasmSections(bytes)) {
    if (section.id !== 1) continue;
    let [count, offset] = readLEB(bytes, section.payload);
    while (count--) {
      if (bytes[offset++] !== 0x60) throw new Error('Only function types are supported');
      let n;
      [n, offset] = readLEB(bytes, offset);
      const params = [...bytes.subarray(offset, offset + n)].map(valueType);
      offset += n;
      [n, offset] = readLEB(bytes, offset);
      const results = [...bytes.subarray(offset, offset + n)].map(valueType);
      offset += n;
      types.push({ params, results });
    }
  }
  return types;
}

/**
 * The imports: { module, name, kind, type } for functions (type index), { limits } for memories
 * and tables, { valueType, mutable } for globals.
 */
export function wasmImports(bytes) {
  const imports = [];
  for (const section of wasmSections(bytes)) {
    if (section.id !== 2) continue;
    let [count, offset] = readLEB(bytes, section.payload);
    while (count--) {
      const entry = {};
      [entry.module, offset] = readString(bytes, offset);
      [entry.name, offset] = readString(bytes, offset);
      const kind = bytes[offset++];
      if (kind === 0) {
        entry.kind = 'function';
        [entry.type, offset] = readLEB(bytes, offset);
      } else if (kind === 1) {
        entry.kind = 'table';
        entry.element = valueType(bytes[offset++]);
        [entry.limits, offset] = readLimits(bytes, offset);
      } else if (kind === 2) {
        entry.kind = 'memory';
        [entry.limits, offset] = readLimits(bytes, offset);
      } else if (kind === 3) {
        entry.kind = 'global';
        entry.valueType = valueType(bytes[offset++]);
        entry.mutable = bytes[offset++] === 1;
      } else throw new Error(`Unsupported import kind ${kind}`);
      imports.push(entry);
    }
  }
  return imports;
}

const EXPORT_KINDS = ['function', 'table', 'memory', 'global', 'tag'];

/** The exports: { name, kind, index }. */
export function wasmExports(bytes) {
  const exports = [];
  for (const section of wasmSections(bytes)) {
    if (section.id !== 7) continue;
    let [count, offset] = readLEB(bytes, section.payload);
    while (count--) {
      const entry = {};
      [entry.name, offset] = readString(bytes, offset);
      entry.kind = EXPORT_KINDS[bytes[offset++]];
      [entry.index, offset] = readLEB(bytes, offset);
      exports.push(entry);
    }
  }
  return exports;
}

/** Names of the functions (index -> name) from the "name" section; empty without one. */
export function functionNames(bytes) {
  const names = new Map();
  for (const section of wasmSections(bytes)) {
    if (section.name !== 'name') continue;
    let [, offset] = readLEB(bytes, section.payload);
    offset += Buffer.byteLength('name');
    while (offset < section.end) {
      const subsection = bytes[offset++];
      let size;
      [size, offset] = readLEB(bytes, offset);
      if (subsection === 1) {
        let [count, at] = readLEB(bytes, offset);
        while (count--) {
          let index;
          let name;
          [index, at] = readLEB(bytes, at);
          [name, at] = readString(bytes, at);
          names.set(index, name);
        }
      }
      offset += size;
    }
  }
  return names;
}

/** The module without the sections for which `drop(section)` is true. */
export function withoutSections(bytes, drop) {
  const parts = [bytes.subarray(0, 8)];
  for (const section of wasmSections(bytes))
    if (!drop(section)) parts.push(bytes.subarray(section.start, section.end));
  return Buffer.concat(parts);
}

/** The module with only the exports for which `keep(exportEntry)` is true. */
export function withExports(bytes, keep) {
  const parts = [bytes.subarray(0, 8)];
  for (const section of wasmSections(bytes)) {
    if (section.id !== 7) {
      parts.push(bytes.subarray(section.start, section.end));
      continue;
    }
    let [count, offset] = readLEB(bytes, section.payload);
    const kept = [];
    while (count--) {
      const start = offset;
      let name;
      [name, offset] = readString(bytes, offset);
      const kind = EXPORT_KINDS[bytes[offset++]];
      let index;
      [index, offset] = readLEB(bytes, offset);
      if (keep({ name, kind, index })) kept.push(bytes.subarray(start, offset));
    }
    const payload = Buffer.concat([encodeLEB(kept.length), ...kept]);
    parts.push(Buffer.from([7]), encodeLEB(payload.length), payload);
  }
  return Buffer.concat(parts);
}

/** Size in bytes of every function body of the code section, in order of the defined functions. */
export function functionSizes(bytes) {
  const sizes = [];
  for (const section of wasmSections(bytes)) {
    if (section.id !== 10) continue;
    let [count, offset] = readLEB(bytes, section.payload);
    while (count--) {
      const [size, body] = readLEB(bytes, offset);
      sizes.push(body + size - offset);
      offset = body + size;
    }
  }
  return sizes;
}
