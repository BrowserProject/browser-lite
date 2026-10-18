// Starts the engine in node with one view and an HTML page, through the same
// contract as a host (engine/abi.json). For render-test.mjs and gc-test.mjs.
//
// Environment: JSC_* (JSC options, e.g. JSC_useLLIntICs=false) and BL_* (engine
// switches, e.g. BL_DEBUG=1) go into the environment of the engine. Without
// BL_FEATURES the engine enables all features.
import { createRequire } from 'node:module';
import path from 'node:path';

// onConsole(message): console of the page. onLoad({ engine, viewId }): page loaded.
// onFrame({ engine, viewId, ptr, width, height }): finished frame (RGBA in engine
// memory); without onFrame every frame is reported as presented right away.
export async function runEngine({ enginePath, html, url, width, height, onConsole = () => {}, onLoad = () => {}, onFrame = null }) {
  const createEngine = createRequire(import.meta.url)(path.resolve(enginePath));
  // Emscripten (MODULARIZE) uses exactly this object as Module, so the exports
  // (_bl_...) are available on it in the callbacks already.
  const engine = {
    // engine.wasm and engine.data are next to engine.js
    locateFile: (file) => path.join(path.dirname(path.resolve(enginePath)), file),
    preRun: [(module) => {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('JSC_') || key.startsWith('BL_'))
          module.ENV[key] = value;
      }
    }],
    onEngineReady() {
      console.log('Engine ready');
      engine._bl_create_view(1, width, height, 1);
      engine._bl_load_html(1, engine.stringToNewUTF8(html), engine.stringToNewUTF8(url));
    },
    onEngineEvent(viewId, type, payload) {
      if (type === 'console') {
        const { message } = JSON.parse(payload);
        console.log('[page]', message);
        onConsole(message);
      } else if (type === 'load') {
        onLoad({ engine, viewId });
      } else if (type === 'error') {
        console.error('[error]', payload);
      }
    },
    // node has no requestAnimationFrame
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
