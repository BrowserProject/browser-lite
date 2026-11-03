// Renders an HTML file with the engine in node and stores the frame as PPM.
// Uses exactly the same contract as a host (engine/abi.json).
//
//   node tests/engine/render.mjs <engine-dir|engine.js> <page.html> <output.ppm> [width] [height]
//
// RENDER_WAIT_FOR=text: only done when the page logged a console line with
// this text (e.g. at the end of a test).
// RENDER_TIMEOUT=seconds: time limit (default 120).
// RENDER_URL=url: base URL of the page (default file:///test/).
// JSC_* and BL_* go to the engine (engine-node.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { enginePath, runEngine } from './engine-node.mjs';

const [engineArg, htmlPath, outPath, widthArg, heightArg] = process.argv.slice(2);
if (!engineArg || !htmlPath || !outPath) {
  console.error(
    'Usage: render.mjs <engine-dir|engine.js> <page.html> <output.ppm> [width] [height]',
  );
  process.exit(2);
}

const waitFor = process.env.RENDER_WAIT_FOR;
const seconds = Number(process.env.RENDER_TIMEOUT || 120);
let waited = !waitFor;
let loaded = false;
let pendingFrame = null;
const timeout = setTimeout(() => {
  console.error(
    waited
      ? `ERROR: timeout (${seconds}s), no frame received`
      : `ERROR: timeout (${seconds}s), "${waitFor}" did not arrive`,
  );
  process.exit(1);
}, seconds * 1000);

// The last frame before the load ended: with nothing changed afterwards no new frame comes
let lastFrame = null;

function savePPM({ rgba, width, height }) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  writeFileSync(outPath, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
  console.log(`Frame saved: ${outPath} (${width}x${height})`);
}

await runEngine({
  enginePath: enginePath(engineArg),
  html: readFileSync(htmlPath, 'utf8'),
  url: process.env.RENDER_URL || 'file:///test/',
  width: Number(widthArg || 800),
  height: Number(heightArg || 600),
  onConsole(message) {
    if (waited || !message.includes(waitFor)) return;
    waited = true;
    if (pendingFrame) pendingFrame();
    // If nothing changed no new frame comes: then done without a frame
    setTimeout(() => {
      console.log('Done (no new frame)');
      process.exit(0);
    }, 3000);
  },
  onLoad({ engine, viewId }) {
    loaded = true;
    engine._bl_frame(viewId);
    // The page painted before its load ended and has not changed since
    setTimeout(() => {
      if (!waited || !lastFrame) return;
      savePPM(lastFrame);
      clearTimeout(timeout);
      process.exit(0);
    }, 3000);
  },
  onFrame(frame) {
    const { engine, viewId, ptr, width, height } = frame;
    const rgba = Buffer.from(engine.HEAPU8.subarray(ptr, ptr + width * height * 4));
    if (!loaded || !waited) {
      // Not done yet: keep the frame, continue with the next one
      lastFrame = { rgba, width, height };
      if (loaded) pendingFrame = () => engine._bl_frame(viewId);
      engine._bl_frame_presented(viewId);
      return;
    }
    savePPM({ rgba, width, height });
    clearTimeout(timeout);
    process.exit(0);
  },
});
