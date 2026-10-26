// Makes a folder of delivered files smaller:
//  1. removes the "name" section of the .wasm files (function names, only for stack traces,
//     about 10% of the size)
//  2. puts .br and .gz next to files of 1 KB and more; the server delivers them directly
//     (serveStatic of packages/server)
//
//   node tools/optimize-assets.mjs [--strip-only] <folder>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { withoutSections } from './wasm-binary.mjs';

const args = process.argv.slice(2);
const stripOnly = args[0] === '--strip-only';
const dir = stripOnly ? args[1] : args[0];
if (!dir) {
  console.error('Usage: optimize-assets.mjs [--strip-only] <folder>');
  process.exit(2);
}

function stripNameSection(bytes) {
  let removed = 0;
  const stripped = withoutSections(bytes, (section) => {
    if (section.name !== 'name') return false;
    removed += section.end - section.start;
    return true;
  });
  return [stripped, removed];
}

function* files(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else yield full;
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

for (const file of [...files(dir)]) {
  if (file.endsWith('.br') || file.endsWith('.gz')) continue;
  let data = readFileSync(file);
  if (file.endsWith('.wasm')) {
    const [stripped, removed] = stripNameSection(data);
    if (removed) {
      writeFileSync(file, stripped);
      console.log(`${file}: name section removed (${mb(removed)})`);
      data = stripped;
    }
  }
  if (stripOnly || statSync(file).size < 1024) continue;
  const br = zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = zlib.gzipSync(data, { level: 9 });
  writeFileSync(`${file}.br`, br);
  writeFileSync(`${file}.gz`, gz);
  console.log(`${file}: ${mb(data.length)} -> br ${mb(br.length)}, gz ${mb(gz.length)}`);
}
