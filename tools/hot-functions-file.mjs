// engine/hot-functions.txt (#238): the engine functions that stay in engine.wasm when
// tools/split-engine.mjs splits it. One line per function: the FNV-1a hash of its name (8 hex),
// followed by " main" when the page's main thread ran it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** FNV-1a (32 bit) of the UTF-8 bytes of `name`, 8 hex digits. */
export function nameHash(name) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** hash -> { main } of a list file; empty when there is none. */
export function readHotList(file) {
  const list = new Map();
  if (!existsSync(file)) return list;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [hash, flag] = line.trim().split(/\s+/);
    if (!hash || hash.startsWith('#')) continue;
    if (!/^[0-9a-f]{8}$/.test(hash)) throw new Error(`${file}: bad line "${line}"`);
    list.set(hash, { main: flag === 'main' || !!list.get(hash)?.main });
  }
  return list;
}

/** Writes `list` (hash -> { main }) sorted, with a header. */
export function writeHotList(file, list) {
  const lines = [...list.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hash, { main }]) => (main ? `${hash} main` : hash));
  const header = [
    '# Engine functions kept in engine.wasm by tools/split-engine.mjs (#238): FNV-1a hashes of',
    '# their names, "main" when the page main thread ran them. Written by tools/hot-functions.mjs.',
  ];
  writeFileSync(file, `${[...header, ...lines].join('\n')}\n`);
}
