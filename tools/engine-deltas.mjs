// Deltas of a packaged engine against the previous one (Compression Dictionary Transport, #244):
// browser-lite-server marks every file of engine/<hash>/ as a dictionary for the same path of the
// next engine version (packages/server, Use-As-Dictionary). For every file of <new> that also
// exists in <old> and differs, this writes <file>.<sha256 hex of the old file>.dcz next to it:
// the dcz header (zstd magic of a skippable frame and the SHA-256 of the dictionary), then the
// file compressed with zstd against the old one. The server sends it when the browser offers the
// old file; a returning visitor then loads about 1 MB instead of the whole engine.wasm.
// Skipped when not clearly smaller than the Brotli file.
//
//   node tools/engine-deltas.mjs <new engine/<hash> folder> <old engine/<hash> folder>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0]);
// Chrome decodes dcz with a window up to 128 MB (2^27)
const MAX_WINDOW_LOG = 27;
// Worth it only if clearly smaller than Brotli
const MAX_SHARE_OF_BROTLI = 0.8;

const [newDir, oldDir] = process.argv.slice(2);
if (!newDir || !oldDir) {
  console.error('Usage: engine-deltas.mjs <new engine folder> <old engine folder>');
  process.exit(2);
}

/** Files of an engine folder relative to it, without precompressed variants. */
function files(dir, prefix = '') {
  return readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) return files(dir, name);
    return /\.(br|gz|dcz)$/.test(name) ? [] : [name];
  });
}

let written = 0;
let deltaBytes = 0;
let brotliBytes = 0;
for (const name of files(newDir)) {
  const oldFile = path.join(oldDir, name);
  if (!existsSync(oldFile)) continue;
  const file = path.join(newDir, name);
  const data = readFileSync(file);
  const dictionary = readFileSync(oldFile);
  const windowLog = Math.min(
    MAX_WINDOW_LOG,
    Math.max(10, Math.ceil(Math.log2(data.length + dictionary.length))),
  );
  const delta = zlib.zstdCompressSync(data, {
    dictionary,
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: 22,
      [zlib.constants.ZSTD_c_windowLog]: windowLog,
      [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
    },
  });
  const brotli = existsSync(`${file}.br`) ? statSync(`${file}.br`).size : data.length;
  if (delta.length + 40 > brotli * MAX_SHARE_OF_BROTLI) continue;
  const hash = createHash('sha256').update(dictionary).digest();
  writeFileSync(`${file}.${hash.toString('hex')}.dcz`, Buffer.concat([DCZ_MAGIC, hash, delta]));
  written++;
  deltaBytes += delta.length + 40;
  brotliBytes += brotli;
}
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
console.log(
  `engine-deltas: ${written} deltas against ${path.basename(oldDir)}, ${mb(deltaBytes)} instead of ${mb(brotliBytes)} Brotli`,
);
