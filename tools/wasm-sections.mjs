// Reads the sections of a WebAssembly module (used by optimize-assets.mjs and
// engine-manifest.mjs).

function readLEB(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, offset];
  }
}

/**
 * Yields every section of the module in `bytes` (a Buffer): id, name (custom sections only),
 * start and end of the whole section and start of its payload after the name.
 */
export function* wasmSections(bytes) {
  let offset = 8;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const [size, dataStart] = readLEB(bytes, offset);
    const end = dataStart + size;
    let name;
    let payload = dataStart;
    if (id === 0) {
      const [nameLength, nameStart] = readLEB(bytes, dataStart);
      name = bytes.subarray(nameStart, nameStart + nameLength).toString();
      payload = nameStart + nameLength;
    }
    yield { id, name, start, end, payload };
    offset = end;
  }
}
