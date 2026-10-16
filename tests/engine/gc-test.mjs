// Fuehrt tests/engine/gc-stress.html in der Engine (node) aus und wartet auf das Ergebnis.
//   JSC_slowPathAllocsBetweenGCs=10 node tests/engine/gc-test.mjs <engine.js>
//
// Mit der JSC-Option laeuft der GC sehr oft. Ohne die GC-Verschiebung der Engine
// (EngineLoop.cpp, Patch 0012) und ohne --spill-pointers stuerzt dieser Test ab.
import { readFileSync } from 'node:fs';
import { runEngine } from './engine-node.mjs';

setTimeout(() => {
  console.error('FEHLER: Zeitlimit (180 s)');
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
