// Rendert eine HTML-Datei mit der Engine in node und speichert das Bild als PPM.
// Benutzt genau die gleiche Schnittstelle wie die Browser-Oberflaeche (web/).
//
//   node tests/engine/render-test.mjs <engine.js> <seite.html> <ausgabe.ppm> [breite] [hoehe]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [enginePath, htmlPath, outPath, widthArg, heightArg] = process.argv.slice(2);
if (!enginePath || !htmlPath || !outPath) {
  console.error('Aufruf: render-test.mjs <engine.js> <seite.html> <ausgabe.ppm> [breite] [hoehe]');
  process.exit(2);
}
const width = Number(widthArg || 800);
const height = Number(heightArg || 600);
const html = readFileSync(htmlPath, 'utf8');

const require = createRequire(import.meta.url);
const createEngine = require(path.resolve(enginePath));

const timeout = setTimeout(() => {
  console.error('FEHLER: Timeout (60s), kein Bild bekommen');
  process.exit(1);
}, 60000);

let loaded = false;
// Emscripten (MODULARIZE) benutzt genau dieses Objekt als Module, darum sind
// die Exports (_bl_...) schon in den Callbacks darauf verfuegbar.
const engine = {
  // engine.wasm und engine.data liegen neben engine.js
  locateFile: (file) => path.join(path.dirname(path.resolve(enginePath)), file),
  // BL_DEBUG=1: Ablauf der Engine mit Zeitstempeln
  preRun: [(module) => {
    if (process.env.BL_DEBUG)
      module.ENV.BL_DEBUG = '1';
  }],
  onEngineReady() {
    console.log('Engine bereit');
    engine._bl_create_view(1, width, height, 1);
    engine._bl_load_html(1, engine.stringToNewUTF8(html), engine.stringToNewUTF8('file:///test/'));
  },
  onEngineEvent(viewId, type, payload) {
    if (type === 'console')
      console.log('[seite]', payload);
    if (type === 'load') {
      loaded = true;
      engine._bl_frame(viewId);
    }
    if (type === 'error')
      console.error('[fehler]', payload);
  },
  onEngineNeedsFrame(viewId) {
    // In node gibt es kein requestAnimationFrame
    setTimeout(() => engine._bl_frame(viewId), 16);
  },
  onEngineFrame(viewId, ptr, w, h) {
    if (!loaded) {
      engine._bl_frame_presented(viewId);
      return;
    }
    const rgba = engine.HEAPU8.slice(ptr, ptr + w * h * 4);
    const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    writeFileSync(outPath, Buffer.concat([header, rgb]));
    console.log(`Bild gespeichert: ${outPath} (${w}x${h})`);
    clearTimeout(timeout);
    process.exit(0);
  },
  engineDialog(type, message) {
    console.log('[dialog]', type, message);
    return 0;
  },
  print: (text) => console.log(text),
  printErr: (text) => console.error(text),
};
await createEngine(engine);
