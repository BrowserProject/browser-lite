// Runs tests/engine/gc-stress.html in the engine (node) and waits for the result.
//   JSC_slowPathAllocsBetweenGCs=10 node tests/engine/gc-test.mjs <engine.js>
//
// With the JSC option the GC runs very often. Without the engine's GC deferral
// (EngineLoop.cpp, patch 0012) and without --spill-pointers this test crashes.
import { readFileSync } from 'node:fs';
import { runEngine } from './engine-node.mjs';

setTimeout(() => {
  console.error('ERROR: time limit (180 s)');
  process.exit(1);
}, 180000);

await runEngine({
  enginePath: process.argv[2],
  html: readFileSync(new URL('gc-stress.html', import.meta.url), 'utf8'),
  url: 'file:///gc/',
  width: 400,
  height: 300,
  onConsole(message) {
    if (message.startsWith('GC-TEST ok'))
      process.exit(0);
    if (message.startsWith('GC-TEST'))
      process.exit(1);
  },
});
