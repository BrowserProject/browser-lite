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

// Chrome can abort a synchronous request, for example while another request for the same file
// runs: a few tries
function blRetry(read) {
  for (let attempt = 1; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (attempt === 4) throw error;
      const until = performance.now() + 100 * attempt;
      if (ENVIRONMENT_IS_PTHREAD) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
      else while (performance.now() < until);
    }
  }
}

function blReadChunk(chunk) {
  return blRetry(() => blReadChunkOnce(chunk));
}

// Throws (a try of blRetry) for anything but a WebAssembly module: Emscripten's readBinary in a
// worker passes an error page or an empty answer on (Firefox: "CompileError ... magic number")
function blReadChunkOnce(chunk) {
  const url = locateFile(`engine.deferred-${chunk}.wasm`);
  let bytes;
  if (ENVIRONMENT_IS_NODE) bytes = readBinary(url);
  else if (ENVIRONMENT_IS_PTHREAD) {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.responseType = 'arraybuffer';
    request.send();
    if (request.status !== 200) throw new Error(`${url}: HTTP ${request.status}`);
    bytes = new Uint8Array(request.response);
  } else {
    // On the page main thread a synchronous request cannot ask for an ArrayBuffer
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send();
    if (request.status !== 200) throw new Error(`${url}: HTTP ${request.status}`);
    const text = request.responseText;
    bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  }
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
    throw new Error(`${url}: no WebAssembly module (${bytes.length} bytes)`);
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
