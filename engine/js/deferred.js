// Deferred engine code (#238, tools/split-engine.mjs). The trampolines of a split engine.wasm
// call the import bl_load_deferred(chunk, slot) (engine/src/main.cpp) for a function of chunk
// engine.deferred-<chunk>.wasm that the calling thread has not instantiated yet, and call the
// function after it returns.
//
// The host compiles the chunks after the start and hands each to Module.blSetDeferred. The main
// thread instantiates them right away (it can neither download nor compile a module that large
// synchronously); every worker gets the modules and instantiates a chunk at its first call into
// it. A worker that needs a chunk before it arrived reads it synchronously (from the HTTP cache
// once the host's download is through) and compiles it, as node always does.

var blDeferred = { modules: [], instances: [] };

function blLoadDeferred(chunk, slot) {
  if (!blDeferred.modules[chunk]) {
    if (!ENVIRONMENT_IS_PTHREAD && !ENVIRONMENT_IS_NODE)
      abort(`engine.deferred-${chunk}.wasm needed on the main thread before it loaded (slot ${slot})`);
    const bytes = readBinary(locateFile(`engine.deferred-${chunk}.wasm`));
    blDeferred.modules[chunk] = new WebAssembly.Module(bytes);
  }
  blDeferred.instances[chunk] ??= new WebAssembly.Instance(blDeferred.modules[chunk], {
    bl_primary: wasmExports,
  });
}

if (ENVIRONMENT_IS_PTHREAD) {
  // The Emscripten worker ignores messages without "cmd"; node has no self
  if (typeof self !== 'undefined')
    self.addEventListener('message', (event) => {
      const chunk = event.data?.blDeferredChunk;
      if (chunk !== undefined) blDeferred.modules[chunk] ??= event.data.module;
    });
} else {
  const send = (worker, chunk) =>
    worker.postMessage({ blDeferredChunk: chunk, module: blDeferred.modules[chunk] });
  let workersPatched = false;
  Module.blSetDeferred = (chunk, module) => {
    blDeferred.modules[chunk] = module;
    for (const worker of PThread.unusedWorkers) send(worker, chunk);
    for (const worker of Object.values(PThread.pthreads)) send(worker, chunk);
    // Workers loaded later get the chunks right after engine.wasm
    if (!workersPatched) {
      workersPatched = true;
      const load = PThread.loadWasmModuleToWorker;
      PThread.loadWasmModuleToWorker = (worker) => {
        const loaded = load(worker);
        blDeferred.modules.forEach((_, index) => send(worker, index));
        return loaded;
      };
    }
    return WebAssembly.instantiate(module, { bl_primary: wasmExports }).then((instance) => {
      blDeferred.instances[chunk] ??= instance;
    });
  };
}
