// Deferred engine code (#238, tools/split-engine.mjs). The trampolines of a split engine.wasm
// call the import bl_load_deferred (engine/src/main.cpp) for a function of engine.deferred.wasm
// that the calling thread has not instantiated yet, and call the function after it returns.
//
// The host compiles engine.deferred.wasm after the start and hands it to Module.blSetDeferred.
// The main thread instantiates it right away (it can neither download nor compile a module that
// large synchronously); every worker gets the module and instantiates it at its first deferred
// call. A worker that needs it before it arrived reads it synchronously (from the HTTP cache once
// the host's download is through) and compiles it, as node always does.

var blDeferred = { module: null, instance: null };

function blLoadDeferred(slot) {
  if (!blDeferred.module) {
    if (!ENVIRONMENT_IS_PTHREAD && !ENVIRONMENT_IS_NODE)
      abort(`engine.deferred.wasm needed on the main thread before it loaded (slot ${slot})`);
    blDeferred.module = new WebAssembly.Module(readBinary(locateFile('engine.deferred.wasm')));
  }
  blDeferred.instance ??= new WebAssembly.Instance(blDeferred.module, { bl_primary: wasmExports });
}

if (ENVIRONMENT_IS_PTHREAD) {
  // The Emscripten worker ignores messages without "cmd"; node has no self
  if (typeof self !== 'undefined')
    self.addEventListener('message', (event) => {
      if (event.data?.blDeferred) blDeferred.module ??= event.data.blDeferred;
    });
} else {
  Module.blSetDeferred = (module) => {
    blDeferred.module = module;
    const send = (worker) => worker.postMessage({ blDeferred: module });
    for (const worker of PThread.unusedWorkers) send(worker);
    for (const worker of Object.values(PThread.pthreads)) send(worker);
    // Workers loaded later get it right after engine.wasm
    const load = PThread.loadWasmModuleToWorker;
    PThread.loadWasmModuleToWorker = (worker) => {
      const loaded = load(worker);
      send(worker);
      return loaded;
    };
    return WebAssembly.instantiate(module, { bl_primary: wasmExports }).then((instance) => {
      blDeferred.instance ??= instance;
    });
  };
}
