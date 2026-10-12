// Wird vor den generierten Emscripten-Code gesetzt (--pre-js).
// Laeuft im Haupt-Thread UND in jedem Worker. Die eigentliche Browser-UI liegt
// in web/ und setzt Module.onEngineReady, onEngineEvent, onEngineFrame,
// onEngineNeedsFrame und engineDialog.
if (typeof Module === 'undefined')
  var Module = {};

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
      Module.blCanvases.set(data.viewId, { canvas: data.blCanvas, ctx: data.blCanvas.getContext('2d', { alpha: false }) });
      Module._bl_canvas_attached(data.viewId);
    });
} else {
  // Worker des Engine-Threads (null solange die Engine nicht laeuft)
  Module.blEngineWorker = () => {
    const thread = Module._bl_engine_thread();
    return thread ? PThread.pthreads[thread] || null : null;
  };
}
