// Runs every *-test.mjs of a suite folder one after the other and prints a summary.
//
//   node tests/run.mjs <suite> [filter] [--engine=<dir>]
//
// suite: contract, engine-js, engine, core, demo, compat. filter: only files whose name contains
// it. The suites engine, core, demo and compat get the engine folder as first argument
// (--engine, BL_ENGINE_DIR or build/webcore/bin). For demo the demo is built once into a temporary
// folder unless E2E_SITE_DIR names one (for example the output of tools/package-demo.sh).
// In GitHub Actions every test is a collapsible group. Exit code 1 when a test failed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SUITES = ['contract', 'engine-js', 'engine', 'core', 'demo', 'compat'];
const WITH_ENGINE = new Set(['engine', 'core', 'demo', 'compat']);

const args = process.argv.slice(2);
const engineArg = args.find((arg) => arg.startsWith('--engine='));
const [suite, filter = ''] = args.filter((arg) => !arg.startsWith('--'));
if (!SUITES.includes(suite)) {
  console.error(`Usage: node tests/run.mjs <${SUITES.join('|')}> [filter] [--engine=<dir>]`);
  process.exit(2);
}
const engineDir = path.resolve(
  engineArg?.slice('--engine='.length) ||
    process.env.BL_ENGINE_DIR ||
    path.join(root, 'build', 'webcore', 'bin'),
);
const ci = !!process.env.GITHUB_ACTIONS;

const folder = path.join(here, suite);
const tests = fs
  .readdirSync(folder)
  .filter((name) => name.endsWith('-test.mjs') && name.includes(filter))
  .sort();
if (!tests.length) {
  console.error(`No tests in ${path.relative(root, folder)} match "${filter}"`);
  process.exit(2);
}

const env = { ...process.env, BL_ENGINE_DIR: engineDir };
let demoDir = null;
if (suite === 'demo' && !env.E2E_SITE_DIR) {
  const { buildDemo } = await import('./lib/site.mjs');
  demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-demo-site-'));
  console.log(`Building the demo once into ${demoDir}`);
  buildDemo(demoDir, engineDir);
  env.E2E_SITE_DIR = demoDir;
}

const results = [];
for (const name of tests) {
  const started = Date.now();
  console.log(ci ? `::group::${suite}/${name}` : `\n=== ${suite}/${name}`);
  const run = spawnSync(
    process.execPath,
    [path.join(folder, name), ...(WITH_ENGINE.has(suite) ? [engineDir] : [])],
    {
      cwd: root,
      env,
      stdio: 'inherit',
    },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = run.status === 0;
  if (ci) console.log('::endgroup::');
  if (!ok && ci)
    console.log(`::error title=${suite}/${name}::failed (exit ${run.status ?? run.signal})`);
  results.push({ name, ok, seconds, code: run.status ?? run.signal });
}
if (demoDir) fs.rmSync(demoDir, { recursive: true, force: true });

console.log(`\nSuite ${suite}:`);
for (const { name, ok, seconds, code } of results)
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} ${String(seconds).padStart(5)} s${ok ? '' : `  (exit ${code})`}`,
  );
const failed = results.filter((result) => !result.ok).length;
console.log(
  failed ? `${failed} of ${results.length} test(s) failed` : `All ${results.length} test(s) ok`,
);
process.exit(failed ? 1 : 0);
