// Runs tests/engine/pages/gc-stress.html in the engine (node) and waits for the result.
//   node tests/engine/gc-test.mjs [engine-dir]
//
// JSC_slowPathAllocsBetweenGCs (default 10 here) lets the GC run very often. Without the engine's GC deferral
// (EngineLoop.cpp, patch 0012) and without --spill-pointers this test crashes.
import { readFileSync } from 'node:fs';
import { enginePath, runEngine } from './engine-node.mjs';

process.env.JSC_slowPathAllocsBetweenGCs ??= '10';

setTimeout(() => {
  console.error('ERROR: time limit (180 s)');
  process.exit(1);
}, 180000);

await runEngine({
  enginePath: enginePath(process.argv[2]),
  html: readFileSync(new URL('pages/gc-stress.html', import.meta.url), 'utf8'),
  url: 'file:///gc/',
  width: 400,
  height: 300,
  onConsole(message) {
    if (message.startsWith('GC-TEST ok')) process.exit(0);
    if (message.startsWith('GC-TEST')) process.exit(1);
  },
});
