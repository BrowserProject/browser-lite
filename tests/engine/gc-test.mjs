// Runs tests/engine/pages/gc-stress.html in the engine (node) and waits for the result.
//   node tests/engine/gc-test.mjs [engine-dir]
//
// JSC_slowPathAllocsBetweenGCs (default 10 here) lets the GC run very often. Without the engine's GC deferral
// (EngineLoop.cpp, patch 0012) and without --spill-pointers this test crashes.
//
// The last rounds leave about 300 MB of garbage each inside a VM entry of its own: a call of
// compiled code (the JIT) to a function that never ran, which JSC's generic call makes, and a
// bound function's call of its target (from the interpreter and from compiled code). The GC has to
// run in there too (patches 0090, 0115), after about 32 MB on a small heap (patch 0091, not 256 MB
// as in JSC's aggressive mode): before, the garbage piled up and the WASM memory grew by that much
// for good (Cloudflare's Turnstile: 0.5 to 1.5 GB; React's render on blick.ch about 120 MB).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { enginePath, runEngine } from './engine-node.mjs';

process.env.JSC_slowPathAllocsBetweenGCs ??= '10';

// The nested rounds of the page, each in an engine of its own (a round that piled up its garbage
// leaves the memory so big that the next one would not need to grow it)
const ROUNDS = ['nested', 'bound', 'bound-compiled'];
// Growth of the WASM memory allowed during a nested round
const NESTED_GROWTH_MB = 128;

if (!process.env.GC_TEST_ROUND) {
  let failed = false;
  for (const round of ROUNDS) {
    const child = spawnSync(process.execPath, [import.meta.filename, ...process.argv.slice(2)], {
      env: { ...process.env, GC_TEST_ROUND: round },
      stdio: 'inherit',
      timeout: 180000,
    });
    if (child.status !== 0) {
      console.log(`ERROR: round "${round}" failed (exit ${child.status ?? child.signal})`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

const round = process.env.GC_TEST_ROUND;
const memoryMB = (engine) => engine.HEAPU8.length / 2 ** 20;
let before = 0;

await runEngine({
  enginePath: enginePath(process.argv[2]),
  html: readFileSync(new URL('pages/gc-stress.html', import.meta.url), 'utf8'),
  url: `file:///gc/#${round}`,
  width: 400,
  height: 300,
  onEvent({ engine, type, payload }) {
    if (type !== 'console') return;
    const { message } = JSON.parse(payload);
    if (message.startsWith('GC-TEST round ')) before = memoryMB(engine);
    else if (message.startsWith('GC-TEST ok')) {
      const growth = memoryMB(engine) - before;
      console.log(`Nested round "${round}": WASM memory ${before} MB, grew by ${growth} MB`);
      if (growth > NESTED_GROWTH_MB) {
        console.log(
          `ERROR: garbage of the ${round} call stayed (more than ${NESTED_GROWTH_MB} MB)`,
        );
        process.exit(1);
      }
      process.exit(0);
    } else if (message.startsWith('GC-TEST')) process.exit(1);
  },
});
