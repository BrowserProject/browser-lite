// Test pages in the engine (node, render.mjs), one engine process each:
//   basic.html     frame checked by check-basic.mjs (box, circle, text, JavaScript)
//   crypto.html    WebCrypto (OpenSSL in WASM)
//   stack.html     stack limit after a VM trap (recursion after a GC request)
//   limits.html    deep DOM, long strings, memory until the end
//   hang.html      watchdog: an endless loop is stopped, the engine keeps running (BL_SCRIPT_TIMEOUT=2)
//   bridges.html   features and host bridges: no __bl globals, disabled features missing (none, all)
//   lazy.html      ICU data and fonts loaded on first use (lazy/ next to the engine)
//   svg-use.html   load events of <use> elements of an external sprite (patch 0051)
//
//   node tests/engine/pages-test.mjs [engine-dir]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..');
const engine = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const out = path.join(root, 'build', 'engine-pages');
mkdirSync(out, { recursive: true });

const CASES = [
  { name: 'basic', size: [800, 600], check: true },
  { name: 'crypto', wait: 'CRYPTO done' },
  { name: 'stack', wait: 'STACK done' },
  { name: 'limits', wait: 'LIMITS done' },
  { name: 'hang', wait: 'HANG done', env: { BL_SCRIPT_TIMEOUT: '2' } },
  { name: 'lazy', wait: 'LAZY done' },
  { name: 'svg-use', size: [400, 40], wait: 'SVGUSE done' },
  {
    name: 'bridges',
    label: 'bridges (no features)',
    wait: 'BRIDGES done',
    env: { BL_FEATURES: '', RENDER_URL: 'file:///test/?features=none' },
  },
  {
    name: 'bridges',
    label: 'bridges (all features)',
    wait: 'BRIDGES done',
    env: { RENDER_URL: 'file:///test/?features=all' },
  },
];

let failed = 0;
for (const { name, label = name, size = [200, 200], wait, env = {}, check } of CASES) {
  const ppm = path.join(out, `${label.replace(/\W+/g, '-')}.ppm`);
  const run = spawnSync(
    process.execPath,
    [
      path.join(here, 'render.mjs'),
      engine,
      path.join(here, 'pages', `${name}.html`),
      ppm,
      ...size.map(String),
    ],
    {
      env: { ...process.env, ...(wait ? { RENDER_WAIT_FOR: wait } : {}), ...env },
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    },
  );
  const output = `${run.stdout}${run.stderr}`;
  let ok = run.status === 0 && (!wait || output.includes(`${wait}=ok`));
  let info = wait
    ? (output.match(new RegExp(`${wait}=\\S*`))?.[0] ?? `exit ${run.status}`)
    : `exit ${run.status}`;
  if (ok && check) {
    const frame = spawnSync(process.execPath, [path.join(here, 'check-basic.mjs'), ppm], {
      encoding: 'utf8',
    });
    process.stdout.write(frame.stdout.replace(/^/gm, '     '));
    ok = frame.status === 0;
    info = ok ? 'frame ok' : 'frame differs';
  }
  if (!ok) process.stdout.write(output.split('\n').slice(-40).join('\n'));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${info}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
