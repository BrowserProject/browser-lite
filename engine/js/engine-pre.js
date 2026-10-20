// Placed before the generated Emscripten code (--pre-js). Runs on the main
// thread AND in every worker. The host sets the Module hooks listed in
// engine/abi.json (onEngineReady, onEngineEvent, onEngineFrame, ...).
if (typeof Module === 'undefined')
  var Module = {};

// abiVersion of engine/abi.json: the host refuses an engine of another contract
Module.blAbiVersion = 3;

// malloc for the JS hosts: without ABORTING_MALLOC _malloc returns 0 when
// memory is full, the write would then go to the start of the WASM memory
Module.blAlloc = (size) => {
  const ptr = Module._malloc(Math.max(size, 1));
  if (!ptr)
    throw new RangeError('Out of memory');
  return ptr;
};

// Frames are painted directly in the engine worker: the host hands the canvas
// of every view to the worker of the presenting thread with
// transferControlToOffscreen. The engine then paints into it itself
// (engine/src/Host.cpp), the main thread copies no pixels and does not wait
// for the compositor. The Emscripten worker ignores messages without "cmd".
if (ENVIRONMENT_IS_PTHREAD) {
  Module.blCanvases = new Map();
  // node (engine tests) has no self and no OffscreenCanvas
  if (typeof self !== 'undefined')
    self.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || !data.blCanvas)
        return;
      // The first frame creates the context: 2d (CPU) or bitmaprenderer (GPU)
      Module.blCanvases.set(data.viewId, { canvas: data.blCanvas });
      Module._bl__canvas_attached(data.viewId);
    });
} else {
  // Worker of the engine thread (null while the engine is not running)
  Module.blEngineWorker = () => {
    const thread = Module._bl__engine_thread();
    return thread ? PThread.pthreads[thread] || null : null;
  };
  // Worker that receives the canvases of the views: the compositor thread
  // (engine/src/Compositor.h), without it the engine thread
  Module.blPresenterWorker = () => {
    const thread = Module._bl__presenter_thread();
    return thread ? PThread.pthreads[thread] || null : null;
  };
  // Stops all engine threads so the host can drop the module. The module is
  // unusable afterwards.
  Module.blShutdown = () => {
    Module.blTransport = null;
    if (typeof blSockets !== 'undefined')
      blSockets.closeAll();
    PThread.terminateAllThreads();
  };
}

// Host files (upload, drop, paste) into the engine file system: the engine
// thread reads them itself in chunks (FileReaderSync) and writes them with
// bl__write_file, so a whole file is never in WASM memory. The engine keeps
// working between the chunks.
// Module.blWriteFiles([{ file, path }]) resolves to true (written) or false per file.
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
          ok = !!Module._bl__write_file(name, buffer, bytes.length, offset);
          await new Promise((resolve) => setTimeout(resolve));
        }
      } catch (error) {
        ok = false; // file gone meanwhile or not readable
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

// Storage namespace of this engine (BL_STORAGE_NAMESPACE): prefix of the Cache
// API names of the HTTP and bytecode caches. Read from the engine once main()
// loaded the configuration. The export is a dependency of wasmfs-opfs.js and as
// such only a local of the module, not a Module field.
function blStorageNamespace() {
  return UTF8ToString(_bl__storage_namespace());
}
