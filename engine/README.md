# engine/

The browser engine: WebCore, JavaScriptCore and our embedder compiled to `engine.js`,
`engine.wasm` and `engine.data`, plus `engine.deferred-<n>.wasm`, chunks of the code the start and
common pages do not run, which the host loads after the start, and `lazy/` with files it loads on
first use (ICU data, fonts). A host (`@browser-lite/core`) loads it into a page, gives it a
transport for TCP connections and drives it through the C exports. What has to change inside
WebKit itself (port `PORT=Wasm`, platform code under `Source/WebCore/platform/wasm/`) comes as
patches from `patches/`.

## Folders

- `abi.json`: the contract with the host, machine readable (exports, module hooks, events,
  features, host calls, environment). `tests/contract/abi-test.mjs` checks it against the
  sources.
- `engine.cmake`: included by the WebKit build (patch 0006): sources, link options, data
  package, the split of the ICU data (`icu-core.txt` is linked, the rest goes to `lazy/icu`
  through `tools/icu-data.mjs`). `BL_PRE_JS` is the only list of the `--pre-js` files. After the
  link `tools/split-engine.mjs` splits `engine.wasm` (`BROWSER_LITE_SPLIT_ENGINE`, #238). Also
  builds the native WTF tests (`tests/engine/wtf-tests.cpp`, `wtf-tests.js`).
- `lazy-prefetch.txt`: files of `lazy/` the engine fetches in the background once it runs (data
  package, #240).
- `hot-functions.txt`: the functions that stay in `engine.wasm` when it is split, written by
  `tools/hot-functions.mjs` ([docs/build.md](../docs/build.md#split-engine)).
- `js/`: JavaScript parts of the engine
  - `engine-pre.js`: module hooks of the engine (canvases, file writes, crash reason, shutdown)
  - `deferred.js`: loads the chunks `engine.deferred-<n>.wasm` into every thread (`Module.blSetDeferred`)
  - `workers.js`: loaded web workers for new threads, a reserve refilled in the background
  - `sockets.js`: TCP streams over `Module.blTransport`
  - `http-cache.js`: HTTP cache in the host's Cache API
  - `webcodecs-host.js`, `mediarecorder-host.js`: WebCodecs and MediaRecorder with the host's
    codecs (WebM muxer)
  - `wasm-rewrite.js`, `wasm-host.js`: WebAssembly of the pages in the browser's WASM engine;
    `wasm-guest.js` is the `WebAssembly` API for the pages and runs in JSC (data package)
  - `wasmfs-opfs.js` (`--js-library`): OPFS root of `/data` and `ENOSPC` for a full OPFS
- `src/`: C++ of the engine
  - Start and loop: `main.cpp`, `EngineConfig.cpp` (every `BL_*` value), `EngineLoop.cpp`
    (event loop, watchdog), `Exports.cpp` (`bl_*`), `Host.cpp` (events to the host),
    `MemoryWatch.cpp` (releases caches, finds the memory limit, memory pressure)
  - Views: `WebView.cpp`, `Clients.cpp`, `EditorClient.cpp`, `BackForwardList.cpp`,
    `Choosers.cpp`, `Printing.cpp`, `PinchZoom.h`
  - Graphics: `GpuRaster.cpp` (Skia over WebGL 2), `LayerTreeHostWasm.cpp` and `Compositor.cpp`
    (layers on the compositor thread), `ScrollingWasm.cpp` (scrolling thread)
  - Network: `LoaderStrategy.cpp`, `Sockets.cpp`, `HttpCache.cpp`, `HttpAuth.cpp` (401 with
    Basic and Digest: stored credentials, the host's sign-in prompt), `PlatformStrategies.cpp`,
    `ErrorPage.cpp`
  - Storage: `Storage.cpp`, `MemoryVFS.cpp` (SQLite), `CacheStorageWasm.cpp`,
    `FileSystemStorageWasm.cpp` (OPFS of the pages), `FileAccessCache.cpp`, `LazyFiles.cpp`
    (files of `lazy/` mounted read only at `/lazy`, fetched on first read)
  - Platform: `ServiceWorkerWasm.cpp`, `WebPlatformExtras.cpp` (polyfills and host bridge),
    `WebRTCPolyfill.cpp`, `DeviceClients.cpp`, `Permissions.cpp`, `Gamepad.cpp`, `Speech.cpp`,
    `PlatformResources.cpp` (WebCore's own images: broken image icon, text area corner)
  - `media/`: `<video>`/`<audio>`, MSE, MediaStream, MediaRecorder, WebCodecs, VideoFrame,
    `VideoOverlay.cpp` (holes of videos the host shows behind the canvas)
  - `wasm/WasmBridge.cpp`: bridge between JSC and the pages' WebAssembly
  - `websocket/`: WebSockets of the pages over curl (from WebKitLegacy, WebKit license)

## Contract

The full list is `abi.json`; the rules behind it:

- Prefixes: `bl_*` exports are for the host. `bl__*` exports are internal, called only from
  `engine/js` or `engine/src`. The host never calls them.
- Strings into exports are UTF-8 allocated with `malloc` (`stringToNewUTF8`), the engine frees
  them. Strings and buffers handed to hooks are copies the host owns, except where `abi.json`
  says the host frees them (`_free`).
- Threads: `main()` runs on its own pthread, the engine thread (`-sPROXY_TO_PTHREAD`). Exports
  may be called from any thread and run asynchronously on the engine thread, unless
  `abi.json` marks them synchronous. Hooks run on the main thread of the page.
  `engineDialog` returns at once; only the asking page waits for `bl_dialog_answer`, the
  engine thread runs the other views meanwhile (#258).
- Frames: the host transfers each view canvas with `transferControlToOffscreen` to
  `Module.blPresenterWorker()` (`{ blCanvas, viewId }`); the engine paints into it, on the
  compositor thread when compositing with WebGL 2. Without that canvas, `onEngineFrame` hands
  RGBA pixels in shared memory and `bl_frame_presented` returns the buffer. `onEngineNeedsFrame`
  asks for `bl_frame` at the next animation frame.
- Audio: `onEngineAudio('start', id, ring, capacityFrames, channels, sampleRate)` hands a ring
  buffer in shared memory: a 32 byte header (uint32 write frame, read frame, capacity, channels,
  heartbeat counter of the reader) followed by interleaved float samples. The engine renders
  ahead and advances the write frame, the host's AudioWorklet reads, advances the read frame
  and the heartbeat. After `'close'` the host frees the ring with `_free`.
- Network: every TCP connection is `Module.blTransport.openTCP(host, port)`, TLS happens inside
  the engine. `onclose(reason)` gets a `CloseReason` string; `Sockets.cpp` maps it to the
  socket error that picks the error page.
- Configuration: the environment (`Module.ENV` in `preRun`) is read once at the start of
  `main()` (`EngineConfig.cpp`). `BL_FEATURES` lists the host services a page may reach;
  a disabled feature looks like a browser without it, and no `__bl*` global is ever visible to
  page scripts. `BL_STORAGE_NAMESPACE` selects the OPFS directory of `/data` and the prefix of
  the Cache API names. `BL_ERROR_PAGE` replaces the error page template (below).
- Error page: shown under the failed address when a main frame navigation does not arrive.
  A `BL_ERROR_PAGE` template gets these placeholders, all HTML-escaped (unknown ones stay):
  `{{lang}}`, `{{kind}}` (`network` or `certificate`), `{{title}}` (the host), `{{heading}}`,
  `{{message}}`, `{{code}}` (e.g. `ERR_NAME_NOT_RESOLVED`), `{{url}}` and `{{retryLabel}}`.
  The engine inserts `<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src 'unsafe-inline'; img-src data:">` at the start, after a leading doctype: no scripts
  and no external resources, inline styles and `data:` images only. A click on any
  `[data-bl-retry]` element retries (a listener the engine installs, the page needs no script).
  The `commit` event reports `errorPage: '<kind>'`.
- Crashes: a thread that traps or aborts writes its error with the stack into engine memory
  before the error event reaches the main thread; `Module.blCrashReason()` returns it.
- Shutdown: `Module.blShutdown()` closes all transport streams and terminates all engine
  threads, so the host can drop the module.

Building: `tools/build-webcore.sh` ([docs/build.md](../docs/build.md)). Threads, storage, media
and GC in context: [docs/architecture.md](../docs/architecture.md).
