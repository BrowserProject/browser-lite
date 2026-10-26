// engine/hot-functions.txt (#238): which engine functions stay in engine.wasm when
// tools/split-engine.mjs splits it. One line per function of the profiled build: the FNV-1a hash
// of its name (8 hex), followed by " main" when the page's main thread ran it, or " cold" when it
// did not run (deferred). Functions not in the list are newer than the profile and stay.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * FNV-1a (32 bit) of the UTF-8 bytes of `name`, 8 hex digits. Without the parts that change with
 * unrelated code: the index wasm-ld appends to a duplicate name ("X::~X()_167505") and the numbers
 * of lambdas ("$_12"). Functions that then share a hash stay together.
 */
export function nameHash(name) {
  const stable = name.replace(/_\d+$/, '').replace(/\$_\d+/g, '$_');
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(stable)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** hash -> { main, cold } of a list file; empty when there is none. */
export function readHotList(file) {
  const list = new Map();
  if (!existsSync(file)) return list;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [hash, flag] = line.trim().split(/\s+/);
    if (!hash || hash.startsWith('#')) continue;
    if (!/^[0-9a-f]{8}$/.test(hash)) throw new Error(`${file}: bad line "${line}"`);
    list.set(hash, { main: flag === 'main', cold: flag === 'cold' });
  }
  return list;
}

/** Writes `list` (hash -> { main, cold }) sorted, with a header. */
export function writeHotList(file, list) {
  const lines = [...list.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hash, { main, cold }]) => (main ? `${hash} main` : cold ? `${hash} cold` : hash));
  const header = [
    '# Engine functions for tools/split-engine.mjs (#238): FNV-1a hashes of their names, "main"',
    '# when the page main thread ran them, "cold" when they did not run (deferred). Functions not',
    '# listed are newer and stay in engine.wasm. Written by tools/hot-functions.mjs.',
  ];
  writeFileSync(file, `${[...header, ...lines].join('\n')}\n`);
}
