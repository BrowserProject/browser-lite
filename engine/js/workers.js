// Web workers for the threads of the engine (#136, #242). Emscripten loads PTHREAD_POOL_SIZE
// workers before the start; a thread that starts when none is left waits until a new worker has
// loaded engine.js and engine.wasm, 60 to 180 ms in which the starting thread (mostly the engine
// thread, WTF waits for a new thread to run) waits too. Emscripten also hands out the newest
// worker first, which may still be loading.
//
// blKeepWorkers(count), on the main thread once the engine runs: threads get loaded workers
// first, and `count` unused workers stay in reserve, loaded again in the background after a
// thread took one. Not during the first seconds: loading workers then competed with the start
// and the first page for the CPU (a small page painted 0.3 s later on 2 cores); the pool covers
// the threads of the start, a page needs more only later.
const BL_RESERVE_DELAY_MS = 3000;
const BL_SLOW_WORKER_MS = 5000;

function blWorkerLog(worker, created, what) {
  const ms = Math.round(performance.now() - created.get(worker));
  const controller = navigator.serviceWorker?.controller?.state ?? 'none';
  console.warn(
    `[workers] engine worker ${what} after ${ms} ms (${PThread.unusedWorkers.length} unused, ` +
      `${Object.keys(PThread.pthreads).length} threads, service worker ${controller})`,
  );
}

function blKeepWorkers(count) {
  // The pool has loaded before the start
  const loaded = new WeakSet(PThread.unusedWorkers);
  const created = new WeakMap();
  const allocate = PThread.allocateUnusedWorker;
  PThread.allocateUnusedWorker = () => {
    const worker = allocate();
    created.set(worker, performance.now());
    // Firefox in CI: now and then a worker loads for about 60 s, then fails without a message
    worker.addEventListener('error', (event) => {
      if (!(event instanceof ErrorEvent)) blWorkerLog(worker, created, 'did not load');
    });
    return worker;
  };
  const load = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) =>
    load(worker).then(() => {
      loaded.add(worker);
      if (performance.now() - created.get(worker) > BL_SLOW_WORKER_MS)
        blWorkerLog(worker, created, 'loaded late');
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
  const reserveFrom = performance.now() + BL_RESERVE_DELAY_MS;
  let refillTimer = 0;
  const scheduleRefill = () => {
    refillTimer ||= setTimeout(() => {
      refillTimer = 0;
      refill();
    }, Math.max(0, reserveFrom - performance.now()));
  };
  PThread.getNewWorker = () => {
    if (!PThread.unusedWorkers.length)
      PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker());
    // Without a loaded one (-1) the newest
    const index = PThread.unusedWorkers.findIndex((worker) => loaded.has(worker));
    const [worker] = PThread.unusedWorkers.splice(index, 1);
    scheduleRefill();
    return worker;
  };
  scheduleRefill();
}
