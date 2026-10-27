// Web workers for the threads of the engine (#136, #242). Emscripten loads PTHREAD_POOL_SIZE
// workers before the start; a thread that starts when none is left waits until a new worker has
// loaded engine.js and engine.wasm, 60 to 180 ms in which the starting thread (mostly the engine
// thread, WTF waits for a new thread to run) waits too. Emscripten also hands out the newest
// worker first, which may still be loading.
//
// blKeepWorkers(count), on the main thread once the engine runs: threads get loaded workers
// first, and `count` unused workers stay in reserve, loaded again in the background after a
// thread took one.

function blKeepWorkers(count) {
  // The pool has loaded before the start
  const loaded = new WeakSet(PThread.unusedWorkers);
  const load = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) =>
    load(worker).then(() => {
      loaded.add(worker);
      return worker;
    });
  // Not after the shutdown (Module.blShutdown), which ends all workers
  let stopped = false;
  const terminate = PThread.terminateAllThreads;
  PThread.terminateAllThreads = () => {
    stopped = true;
    terminate();
  };
  const refill = () => {
    while (!stopped && PThread.unusedWorkers.length < count)
      PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker());
  };
  PThread.getNewWorker = () => {
    if (!PThread.unusedWorkers.length)
      PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker());
    // Without a loaded one (-1) the newest
    const index = PThread.unusedWorkers.findIndex((worker) => loaded.has(worker));
    const [worker] = PThread.unusedWorkers.splice(index, 1);
    setTimeout(refill);
    return worker;
  };
  refill();
}
