// Pins of versions.env and the product version of the root package.json, for the node tools.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Repository root. */
export const root = path.resolve(import.meta.dirname, '..');

/** KEY=VALUE pins of versions.env. */
export const pins = Object.fromEntries(
  readFileSync(path.join(root, 'versions.env'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

/** Product version (root package.json, all packages share it). */
export const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
