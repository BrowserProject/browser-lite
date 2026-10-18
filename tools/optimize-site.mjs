// Macht den fertigen Seiten-Ordner kleiner fuer die Auslieferung:
//  1. Entfernt die "name"-Section aus den .wasm-Dateien (Funktionsnamen,
//     nur fuer Stacktraces, ca. 10% der Groesse)
//  2. Legt .br und .gz neben grosse Dateien, der Server liefert die direkt aus
//     (packages/server/src/static.ts)
//
//   node tools/optimize-site.mjs <ordner>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
  console.error('Aufruf: optimize-site.mjs <ordner>');
  process.exit(2);
}

function readLEB(bytes, offset) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80)
      return [result, offset];
  }
}

function stripNameSection(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  let removed = 0;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const [size, dataStart] = readLEB(bytes, offset);
    const end = dataStart + size;
    let keep = true;
    if (id === 0) {
      const [nameLength, nameStart] = readLEB(bytes, dataStart);
      const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString();
      keep = name !== 'name';
    }
    if (keep)
      parts.push(bytes.subarray(start, end));
    else
      removed += end - start;
    offset = end;
  }
  return [Buffer.concat(parts), removed];
}

function* files(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory())
      yield* files(full);
    else
      yield full;
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

for (const file of [...files(dir)]) {
  if (file.endsWith('.br') || file.endsWith('.gz'))
    continue;
  let data = readFileSync(file);
  if (file.endsWith('.wasm')) {
    const [stripped, removed] = stripNameSection(data);
    if (removed) {
      writeFileSync(file, stripped);
      console.log(`${file}: name-Section entfernt (${mb(removed)})`);
      data = stripped;
    }
  }
  if (statSync(file).size < 1024)
    continue;
  const br = zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = zlib.gzipSync(data, { level: 9 });
  writeFileSync(file + '.br', br);
  writeFileSync(file + '.gz', gz);
  console.log(`${file}: ${mb(data.length)} -> br ${mb(br.length)}, gz ${mb(gz.length)}`);
}
