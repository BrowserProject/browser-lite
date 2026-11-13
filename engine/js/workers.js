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

// A worker whose script did not load gets an error event that is no ErrorEvent (the errors of a
// running thread are). Firefox fails most of several workers that load the same engine.js from
// its HTTP cache at once, like the pool at the start or a refill of the reserve, when the response
// allows byte ranges with validators as static servers send it; one at a time never failed.
// Emscripten's handler threw the event and the worker never loaded: the start waited forever for
// the pool, a thread that had taken such a worker never ran.
//
// blWatchWorkerLoads, on the main thread right after Emscripten created the pool (preInit): such a
// worker is ended and replaced by a new one, the next replacement only once engine.js runs in the
// one before (it says so right away, below). The replacement takes the place of the failed worker:
// in the pool before it loads, else the load of the failed worker (in the pool the run dependency
// of the start) ends with the one of its replacement, and a thread that had taken it moves to the
// replacement, which gets the messages sent to the failed worker after its load request (the start
// of the thread, deferred code). After BL_WORKER_LOAD_TRIES for one place the engine aborts: the
// start or the browser fails with an error instead of waiting.
const BL_WORKER_LOAD_TRIES = 3;

if (ENVIRONMENT_IS_PTHREAD && !ENVIRONMENT_IS_NODE) self.postMessage({ blWorkerRuns: true });

function blWatchWorkerLoads() {
  const listeners = new AbortController();
  const signal = listeners.signal;
  // Per watched worker: its try, whether engine.js runs, whether it failed, its load request and
  // the messages sent to it after the request until engine.js ran
  const places = new WeakMap();
  let stopped = false;
  let turn = Promise.resolve();

  const takeUnused = (worker) => {
    const index = PThread.unusedWorkers.indexOf(worker);
    if (index >= 0) PThread.unusedWorkers.splice(index, 1);
  };

  const watch = (worker) => {
    const place = { tries: 1, runs: false, requested: false, sent: null };
    place.failed = new Promise((resolve) => {
      place.fail = resolve;
    });
    place.ran = new Promise((resolve) => {
      worker.addEventListener(
        'message',
        () => {
          place.runs = true;
          place.sent = null;
          delete worker.postMessage;
          resolve();
        },
        { once: true, signal },
      );
    });
    place.replaced = new Promise((resolve) => {
      place.replaceLoad = resolve;
    });
    places.set(worker, place);
    // Before Emscripten's handler, which is set with the load request
    worker.addEventListener(
      'error',
      (event) => {
        if (event instanceof ErrorEvent || place.runs) return;
        event.stopImmediatePropagation();
        worker.terminate();
        if (place.tries >= BL_WORKER_LOAD_TRIES)
          abort(`engine.js did not load into a web worker (${place.tries} tries)`);
        console.warn(
          `[workers] engine.js did not load into a web worker (try ${place.tries}), ` +
            'loading a new one',
        );
        // Requested: no thread may take it. Else it keeps its place in the pool for the replacement
        if (place.requested) takeUnused(worker);
        place.fail();
        replace(worker, place);
      },
      { signal },
    );
    return worker;
  };

  // A new worker in the place of the failed `worker`, once engine.js runs in the replacement before
  const replace = (worker, place) => {
    turn = turn.then(() => {
      if (stopped || ABORT) return new Promise(() => {});
      const replacement = PThread.allocateUnusedWorker();
      places.get(replacement).tries = place.tries + 1;
      const thread = worker.pthread_ptr;
      if (thread && PThread.pthreads[thread] === worker) {
        takeUnused(replacement);
        replacement.pthread_ptr = thread;
        PThread.pthreads[thread] = replacement;
      }
      if (place.requested) {
        takeUnused(worker);
        place.replaceLoad(PThread.loadWasmModuleToWorker(replacement));
        for (const [message, transfer] of place.sent ?? []) {
          // Transferred objects went with the failed worker
          if (transfer?.length) abort('engine.js did not load into the web worker of a thread');
          replacement.postMessage(message);
        }
      } else {
        // Not requested yet: the pool loads the replacement in its place
        const index = PThread.unusedWorkers.indexOf(worker);
        if (index >= 0) {
          takeUnused(replacement);
          PThread.unusedWorkers[index] = replacement;
        }
      }
      return Promise.race([places.get(replacement).ran, places.get(replacement).failed]);
    });
  };

  // Not in Node (engine tests): worker_threads have no error events of that kind
  if (ENVIRONMENT_IS_NODE) return;
  for (const worker of PThread.unusedWorkers) watch(worker);
  const allocate = PThread.allocateUnusedWorker;
  PThread.allocateUnusedWorker = () => watch(allocate());
  const load = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) => {
    const loaded = load(worker);
    const place = places.get(worker);
    if (!place) return loaded;
    place.requested = true;
    if (!place.runs) {
      // What is sent from now on until engine.js runs, for a replacement
      const sent = [];
      place.sent = sent;
      worker.postMessage = (message, transfer) => {
        sent.push([message, transfer]);
        Worker.prototype.postMessage.call(worker, message, transfer);
      };
    }
    return Promise.race([loaded, place.replaced]);
  };
  const terminate = PThread.terminateAllThreads;
  PThread.terminateAllThreads = () => {
    stopped = true;
    listeners.abort();
    terminate();
  };
}

if (!ENVIRONMENT_IS_PTHREAD)
  Module.preInit = [Module.preInit ?? []].flat().concat(blWatchWorkerLoads);

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
    return worker;
  };
  // Resolves with the worker that loaded: a replacement when `worker` did not load
  const load = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) =>
    load(worker).then((ready) => {
      loaded.add(ready);
      if (performance.now() - created.get(ready) > BL_SLOW_WORKER_MS)
        blWorkerLog(ready, created, 'loaded late');
      return ready;
    });
  // Not after the shutdown (Module.blShutdown), which ends all workers
  let stopped = false;
  const terminate = PThread.terminateAllThreads;
  PThread.terminateAllThreads = () => {
    stopped = true;
    clearTimeout(refillTimer);
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
