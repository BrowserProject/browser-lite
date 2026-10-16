// Startet die Engine in node mit einem View und einer HTML-Seite, ueber die
// gleiche Schnittstelle wie die Oberflaeche (web/). Fuer render-test.mjs und gc-test.mjs.
//
// Umgebung: JSC_* (JSC-Optionen, z.B. JSC_useLLIntICs=false) und BL_* (Schalter
// der Engine, z.B. BL_DEBUG=1) gehen in die Umgebung der Engine.
import { createRequire } from 'node:module';
import path from 'node:path';

// onConsole(message): Konsole der Seite. onLoad({ engine, viewId }): Seite geladen.
// onFrame({ engine, viewId, ptr, width, height }): fertiges Bild (RGBA im Speicher
// der Engine); ohne onFrame wird jedes Bild gleich als gezeigt gemeldet.
export async function runEngine({ enginePath, html, url, width, height, onConsole = () => {}, onLoad = () => {}, onFrame = null }) {
  const createEngine = createRequire(import.meta.url)(path.resolve(enginePath));
  // Emscripten (MODULARIZE) benutzt genau dieses Objekt als Module, darum sind
  // die Exports (_bl_...) schon in den Callbacks darauf verfuegbar.
  const engine = {
    // engine.wasm und engine.data liegen neben engine.js
    locateFile: (file) => path.join(path.dirname(path.resolve(enginePath)), file),
    preRun: [(module) => {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('JSC_') || key.startsWith('BL_'))
          module.ENV[key] = value;
      }
    }],
    onEngineReady() {
      console.log('Engine bereit');
      engine._bl_create_view(1, width, height, 1);
      engine._bl_load_html(1, engine.stringToNewUTF8(html), engine.stringToNewUTF8(url));
    },
    onEngineEvent(viewId, type, payload) {
      if (type === 'console') {
        const { message } = JSON.parse(payload);
        console.log('[seite]', message);
        onConsole(message);
      } else if (type === 'load') {
        onLoad({ engine, viewId });
      } else if (type === 'error') {
        console.error('[fehler]', payload);
      }
    },
    // In node gibt es kein requestAnimationFrame
    onEngineNeedsFrame(viewId) {
      setTimeout(() => engine._bl_frame(viewId), 16);
    },
    onEngineFrame(viewId, ptr, frameWidth, frameHeight) {
      if (onFrame)
        onFrame({ engine, viewId, ptr, width: frameWidth, height: frameHeight });
      else
        engine._bl_frame_presented(viewId);
    },
    engineDialog(viewId, type, origin, message) {
      console.log('[dialog]', type, origin, message);
      return 0;
    },
    print: (text) => console.log(text),
    printErr: (text) => console.error(text),
  };
  await createEngine(engine);
  return engine;
}
