// Wird vor den generierten Emscripten-Code gesetzt (--pre-js).
// Laeuft im Haupt-Thread UND in jedem Worker. Die eigentliche Browser-UI liegt
// in web/ und setzt Module.onEngineReady, onEngineEvent, onEngineFrame,
// onEngineNeedsFrame und engineDialog.
if (typeof Module === 'undefined')
  var Module = {};

// malloc fuer die JS-Hosts: ohne ABORTING_MALLOC gibt _malloc bei vollem
// Speicher 0 zurueck, geschrieben wuerde dann an den Anfang des WASM-Speichers
Module.blAlloc = (size) => {
  const ptr = Module._malloc(Math.max(size, 1));
  if (!ptr)
    throw new RangeError('Out of memory');
  return ptr;
};

// Bilder direkt im Engine-Worker zeichnen: die Oberflaeche gibt das Canvas jedes
// Tabs mit transferControlToOffscreen an den Worker des Engine-Threads
// (web/app.js). Die Engine malt dann selber hinein (engine/src/Host.cpp), der
// Haupt-Thread kopiert keine Pixel mehr und wartet nicht auf den Compositor.
// Nachrichten ohne "cmd" ignoriert der Emscripten-Worker selber.
if (ENVIRONMENT_IS_PTHREAD) {
  Module.blCanvases = new Map();
  // node (Engine-Tests) hat kein self und kein OffscreenCanvas
  if (typeof self !== 'undefined')
    self.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || !data.blCanvas)
        return;
      // Den Kontext legt erst das erste Bild an: 2d (CPU) oder bitmaprenderer (GPU)
      Module.blCanvases.set(data.viewId, { canvas: data.blCanvas });
      Module._bl_canvas_attached(data.viewId);
    });
} else {
  // Worker des Engine-Threads (null solange die Engine nicht laeuft)
  Module.blEngineWorker = () => {
    const thread = Module._bl_engine_thread();
    return thread ? PThread.pthreads[thread] || null : null;
  };
  // Worker, der die Canvas der Tabs bekommt: der Compositor-Thread
  // (engine/src/Compositor.h), ohne ihn der Engine-Thread
  Module.blPresenterWorker = () => {
    const thread = Module._bl_presenter_thread();
    return thread ? PThread.pthreads[thread] || null : null;
  };
}

// Dateien des Host (Upload, Ablegen, Einfuegen, web/app.js) ins Dateisystem der
// Engine: der Engine-Thread liest sie selber in Stuecken (FileReaderSync) und
// schreibt sie mit bl_write_file, so liegt nie eine ganze Datei im
// WASM-Speicher. Zwischen den Stuecken arbeitet die Engine weiter.
// Module.blWriteFiles([{ file, path }]) gibt pro Datei true (geschrieben) oder false.
const BL_FILE_CHUNK = 4 << 20;
if (ENVIRONMENT_IS_PTHREAD) {
  const writeFiles = async (id, files) => {
    const written = [];
    const buffer = Module._malloc(BL_FILE_CHUNK);
    for (const { file, path } of files) {
      const name = stringToNewUTF8(path);
      let ok = !!buffer && !!name;
      try {
        const reader = new FileReaderSync();
        for (let offset = 0; ok && (offset < file.size || !offset); offset += BL_FILE_CHUNK) {
          const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + BL_FILE_CHUNK)));
          new Uint8Array(wasmMemory.buffer, buffer, bytes.length).set(bytes);
          ok = !!Module._bl_write_file(name, buffer, bytes.length, offset);
          await new Promise((resolve) => setTimeout(resolve));
        }
      } catch (error) {
        ok = false; // Datei inzwischen weg oder nicht lesbar
      }
      Module._free(name);
      written.push(ok);
    }
    Module._free(buffer);
    self.postMessage({ blFilesWritten: id, written });
  };
  if (typeof self !== 'undefined')
    self.addEventListener('message', (event) => {
      if (event.data && event.data.blWriteFiles)
        writeFiles(event.data.blWriteFiles, event.data.files);
    });
} else {
  let fileWrites = 0;
  Module.blWriteFiles = (files) => new Promise((resolve) => {
    const worker = Module.blEngineWorker();
    if (!worker)
      return resolve(files.map(() => false));
    const id = ++fileWrites;
    const listener = (event) => {
      if (!event.data || event.data.blFilesWritten !== id)
        return;
      worker.removeEventListener('message', listener);
      resolve(event.data.written);
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ blWriteFiles: id, files });
  });
}
