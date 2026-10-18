// Part of tools/check-style.sh: every package.json pins dependencies exactly, and all
// workspace packages carry the product version of the root package.json.
// Prints one line per violation.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '*package.json', 'package.json'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && !f.includes('node_modules/'));
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const exact = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|file:.*|workspace:.*)$/;

for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!exact.test(range))
        console.log(`${file}: ${field}.${name} is not pinned exactly (${range})`);
    }
  }
  if (file !== 'package.json' && pkg.version !== undefined && pkg.version !== root.version) {
    console.log(`${file}: version ${pkg.version} differs from the root version ${root.version}`);
  }
}
