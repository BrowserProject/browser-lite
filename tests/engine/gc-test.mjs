// Fuehrt tests/engine/gc-stress.html in der Engine (node) aus und wartet auf das Ergebnis.
//   JSC_slowPathAllocsBetweenGCs=10 node tests/engine/gc-test.mjs <engine.js>
//
// Mit der JSC-Option laeuft der GC sehr oft. Ohne die GC-Verschiebung der Engine
// (EngineLoop.cpp, Patch 0012) und ohne --spill-pointers stuerzt dieser Test ab.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enginePath = process.argv[2];
const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'gc-stress.html'), 'utf8');
const require = createRequire(import.meta.url);
const createEngine = require(path.resolve(enginePath));

setTimeout(() => {
  console.error('FEHLER: Zeitlimit (180 s)');
  process.exit(1);
}, 180000);

const engine = {
  locateFile: (file) => path.join(path.dirname(path.resolve(enginePath)), file),
  preRun: [(module) => {
    if (process.env.BL_DEBUG)
      module.ENV.BL_DEBUG = '1';
    // JSC-Optionen weitergeben, z.B. JSC_slowPathAllocsBetweenGCs=10 (GC sehr oft)
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('JSC_'))
        module.ENV[key] = value;
    }
  }],
  onEngineReady() {
    engine._bl_create_view(1, 400, 300, 1);
    engine._bl_load_html(1, engine.stringToNewUTF8(html), engine.stringToNewUTF8('file:///gc/'));
  },
  onEngineEvent(viewId, type, payload) {
    if (type !== 'console')
      return;
    const message = JSON.parse(payload).message;
    console.log('[seite]', message);
    if (message.startsWith('GC-TEST ok'))
      process.exit(0);
    if (message.startsWith('GC-TEST'))
      process.exit(1);
  },
  onEngineNeedsFrame(viewId) {
    setTimeout(() => engine._bl_frame(viewId), 16);
  },
  onEngineFrame(viewId) {
    engine._bl_frame_presented(viewId);
  },
  engineDialog: () => 0,
  print: (text) => console.log(text),
  printErr: (text) => console.error(text),
};
await createEngine(engine);
