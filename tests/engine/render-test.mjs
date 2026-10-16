// Rendert eine HTML-Datei mit der Engine in node und speichert das Bild als PPM.
// Benutzt genau die gleiche Schnittstelle wie die Browser-Oberflaeche (web/).
//
//   node tests/engine/render-test.mjs <engine.js> <seite.html> <ausgabe.ppm> [breite] [hoehe]
//
// RENDER_WAIT_FOR=text: erst fertig, wenn die Seite eine Konsolen-Zeile mit
// diesem Text ausgegeben hat (z.B. am Ende eines Tests).
// RENDER_TIMEOUT=sekunden: Zeitlimit (Standard 120).
// JSC_* und BL_* gehen an die Engine (engine-node.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { runEngine } from './engine-node.mjs';

const [enginePath, htmlPath, outPath, widthArg, heightArg] = process.argv.slice(2);
if (!enginePath || !htmlPath || !outPath) {
  console.error('Aufruf: render-test.mjs <engine.js> <seite.html> <ausgabe.ppm> [breite] [hoehe]');
  process.exit(2);
}

const waitFor = process.env.RENDER_WAIT_FOR;
const seconds = Number(process.env.RENDER_TIMEOUT || 120);
let waited = !waitFor;
let loaded = false;
let pendingFrame = null;
const timeout = setTimeout(() => {
  console.error(waited ? `FEHLER: Timeout (${seconds}s), kein Bild bekommen` : `FEHLER: Timeout (${seconds}s), "${waitFor}" kam nicht`);
  process.exit(1);
}, seconds * 1000);

function savePPM({ engine, ptr, width, height }) {
  const rgba = engine.HEAPU8.subarray(ptr, ptr + width * height * 4);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  writeFileSync(outPath, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
  console.log(`Bild gespeichert: ${outPath} (${width}x${height})`);
}

await runEngine({
  enginePath,
  html: readFileSync(htmlPath, 'utf8'),
  url: 'file:///test/',
  width: Number(widthArg || 800),
  height: Number(heightArg || 600),
  onConsole(message) {
    if (waited || !message.includes(waitFor))
      return;
    waited = true;
    if (pendingFrame)
      pendingFrame();
    // Hat sich nichts geaendert, kommt kein neues Bild: dann ohne Bild fertig
    setTimeout(() => {
      console.log('Fertig (kein neues Bild)');
      process.exit(0);
    }, 3000);
  },
  onLoad({ engine, viewId }) {
    loaded = true;
    engine._bl_frame(viewId);
  },
  onFrame(frame) {
    const { engine, viewId } = frame;
    if (!loaded || !waited) {
      // Noch nicht fertig: Bild verwerfen, beim naechsten weitermachen
      if (loaded)
        pendingFrame = () => engine._bl_frame(viewId);
      engine._bl_frame_presented(viewId);
      return;
    }
    savePPM(frame);
    clearTimeout(timeout);
    process.exit(0);
  },
});
