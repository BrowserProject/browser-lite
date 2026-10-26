// Deferred engine code (#238, tools/split-engine.mjs). The trampolines of a split engine.wasm
// call the import bl_load_deferred(chunk) (engine/src/main.cpp) for a function of chunk
// engine.deferred-<chunk>.wasm that the calling thread has not instantiated yet, and call the
// function after it returns.
//
// The host compiles the chunks after the start and hands each to Module.blSetDeferred: the main
// thread instantiates them right away, every worker gets the modules and instantiates a chunk at
// its first call into it. A thread that needs a chunk before it arrived reads it synchronously
// (from the HTTP cache once the host's download is through) and compiles it, as node always does;
// chunks stay below the 8 MB up to which Chrome compiles synchronously on the page main thread.

var blDeferred = { modules: [], instances: [] };

function blReadChunk(chunk) {
  const url = locateFile(`engine.deferred-${chunk}.wasm`);
  if (ENVIRONMENT_IS_PTHREAD || ENVIRONMENT_IS_NODE) return readBinary(url);
  // On the page main thread a synchronous request cannot ask for an ArrayBuffer
  const request = new XMLHttpRequest();
  request.open('GET', url, false);
  request.overrideMimeType('text/plain; charset=x-user-defined');
  request.send();
  if (request.status !== 200) abort(`${url}: HTTP ${request.status}`);
  const text = request.responseText;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function blLoadDeferred(chunk) {
  blDeferred.modules[chunk] ??= new WebAssembly.Module(blReadChunk(chunk));
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
