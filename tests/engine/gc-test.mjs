// Runs tests/engine/pages/gc-stress.html in the engine (node) and waits for the result.
//   node tests/engine/gc-test.mjs [engine-dir]
//
// JSC_slowPathAllocsBetweenGCs (default 10 here) lets the GC run very often. Without the engine's GC deferral
// (EngineLoop.cpp, patch 0012) and without --spill-pointers this test crashes.
//
// The last round leaves about 300 MB of garbage inside a call of compiled code (the JIT) to a
// function that never ran, which JSC's generic call makes in a VM entry of its own. The GC has to
// run in there too (patch 0090), after about 32 MB on a small heap (patch 0091, not 256 MB as in
// JSC's aggressive mode): before, the garbage piled up and the WASM memory grew by that much for
// good (Cloudflare's Turnstile: 0.5 to 1.5 GB).
import { readFileSync } from 'node:fs';
import { enginePath, runEngine } from './engine-node.mjs';

process.env.JSC_slowPathAllocsBetweenGCs ??= '10';

// Growth of the WASM memory allowed during the nested round
const NESTED_GROWTH_MB = 128;

setTimeout(() => {
  console.error('ERROR: time limit (180 s)');
  process.exit(1);
}, 180000);

const memoryMB = (engine) => engine.HEAPU8.length / 2 ** 20;
let beforeNested = 0;

await runEngine({
  enginePath: enginePath(process.argv[2]),
  html: readFileSync(new URL('pages/gc-stress.html', import.meta.url), 'utf8'),
  url: 'file:///gc/',
  width: 400,
  height: 300,
  onEvent({ engine, type, payload }) {
    if (type !== 'console') return;
    const { message } = JSON.parse(payload);
    if (message.startsWith('GC-TEST nested round')) beforeNested = memoryMB(engine);
    else if (message.startsWith('GC-TEST ok')) {
      const growth = memoryMB(engine) - beforeNested;
      console.log(`Nested round: WASM memory ${beforeNested} MB, grew by ${growth} MB`);
      if (growth > NESTED_GROWTH_MB) {
        console.log(`ERROR: garbage of the nested call stayed (more than ${NESTED_GROWTH_MB} MB)`);
        process.exit(1);
      }
      process.exit(0);
    } else if (message.startsWith('GC-TEST')) process.exit(1);
  },
});
