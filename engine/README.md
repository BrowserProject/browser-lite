# engine/

The browser engine: WebCore, JavaScriptCore and our embedder compiled to `engine.js`,
`engine.wasm` and `engine.data`, plus `engine.deferred-<n>.wasm`, chunks of the code the start and
common pages do not run, which the host loads after the start, and `lazy/` with files it loads on
first use (ICU data, fonts). A host (`@browser-lite/core`) loads it into a page, gives it a
transport for TCP connections and drives it through the C exports. What has to change inside
WebKit itself (port `PORT=Wasm`, platform code under `Source/WebCore/platform/wasm/`, the
generic code paths the port takes, for example formatting of UI strings or the focus a click
gives buttons, checkboxes and links like Chrome on Linux, and what changes when
all sites share one process, for example the microtasks of a site that was left, and WebKit bugs
that real sites hit, for example the hovered element a page from the back/forward cache forgot
or the policy a typed `data:` address took over from the page before, or the missing tiles of
content more than 16.7 million px down a page, or the overlay scrollbars that took the taps at
the right edge of a phone, or the hover a scroll moved to the element under the last tap, or
an interpreter cache that took the missing export of one module for all modules, or the decoded
image a compositing layer still showed, which the memory cache dropped and the layer decoded again,
or the text shadow a filtered layer cut off at its box, or the tiles a fling on a busy page
ran away from, or the boxes with percentage heights every layout of a container laid out again,
or the writes of `navigator.clipboard`, which the pasteboard of the WPE port dropped, or the
fullscreen video a page's `object-fit: cover` cropped, or the icons of the media controls, which
the Adwaita theme reads only from a GResource, or the link address that stayed in the status
when a cookie dialog appeared under a still mouse, or the cells at the edge of a table with
collapsed borders, each of which looked through its whole column while it painted, or the AVIF
images that decoded their whole picture to learn their size and were never freed, or the GPU
WebGL named to pages, always Apple's instead of the host's, so Google Maps drew with WebGL on a
software renderer, or the buffers of an iframe's realm that compression streams refused)
comes as patches from `patches/`.

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
    (event loop: the host's calls and the compositor's answers before the page's work, at most one RunLoop pump waiting, the watchdog that stops a script once the host waited its limit for it), `Exports.cpp` (`bl_*`; hovering mouse moves that wait join into one move that lists
    them all as its coalesced events), `Host.cpp` (events to the host),
    `MemoryWatch.cpp` (releases caches, the pages' compiled JS and the page left last in the
    back/forward cache only when memory is short (patch 0088), JSC's code cache at every release
    and when a view leaves its page (patch 0102), a full GC soon after views closed, finds the
    memory limit, memory pressure
    `moderate` above the budget and `critical` when memory is short),
    `HostRegExp.cpp` (expensive regular expressions in the host's RegExp)
  - Views: `WebView.cpp`, `Clients.cpp` (WebCore's clients: loads, title, back/forward cache
    restore, Tab to links, the popup blocker: a gesture or 5 s of transient activation), `EditorClient.cpp`, `BackForwardList.cpp`,
    `Choosers.cpp` (the host shows the `<select>` list, color and date pickers and the
    suggestions of `<input list>`), `VisitedLinks.cpp` (`:visited`: the addresses the views
    loaded and those of the host's history), `Printing.cpp`, `PinchZoom.h`, `HiddenViews.cpp` (hidden views wait while
    the user works in, types in or waits for a visible one, also for the first frame of a tab
    switched to)
  - Graphics: `GpuRaster.cpp` (Skia over WebGL 2), `LayerTreeHostWasm.cpp` and `Compositor.cpp`
    (layers on the compositor thread, the stall log's state), `DamageTiles.cpp` (a frame with a
    small change goes only into the host canvases of the tiles it touches; emptied with a
    transparent bitmap, `Module.blEmptyBitmap` in `engine-pre.js`, since Safari 18 keeps showing a
    canvas after `transferFromImageBitmap(null)`), `HostLayers.cpp` (layers that only animate
    their opacity get host canvases whose opacity the host animates), `ScrollingWasm.cpp`
    (scrolling thread: wheel, swipe and scroll animations on the compositor's ticks)
  - Network: `LoaderStrategy.cpp` (loads, pings, downloads: a navigation that becomes one
    keeps its request), `SyncLoad.cpp` (synchronous loads like a synchronous `XMLHttpRequest`:
    the page waits like below a dialog, the other views go on), `Sockets.cpp`, `HttpCache.cpp`,
    `HttpAuth.cpp` (401 with Basic and Digest: stored credentials, the host's sign-in prompt),
    `ViewSource.cpp` (`view-source:` pages: the source of the address with numbered lines),
    `PlatformStrategies.cpp`, `ErrorPage.cpp`
  - Storage: `Storage.cpp`, `MemoryVFS.cpp` (SQLite in memory, written by its storage thread),
    `CookieJarWasm.cpp` (Cookie Store API),
    `CacheStorageWasm.cpp`,
    `FileSystemStorageWasm.cpp` (OPFS of the pages), `FileAccessCache.cpp`, `LazyFiles.cpp`
    (files of `lazy/` mounted read only at `/lazy`, fetched on first read), `FontPrefetch.cpp`
    (the fonts and dictionaries the rendered text outside Latin-1 needs, fetched side by side), `FontArrival.cpp`
    (fallback fonts the text went on without arrived: only the text that may take them is laid
    out again)
  - Platform: `ServiceWorkerWasm.cpp` (WebCore's service worker server, page and worker sides
    connected through the RunLoop in IPC order, also the replies; the unsandboxed pages the
    service and shared workers run in), `WebPlatformExtras.cpp`
    (polyfills and host bridge),
    `UserContent.cpp` (scripts and CSS of the host's extensions, isolated worlds),
    `WebRTCPolyfill.cpp`, `DeviceClients.cpp`, `Permissions.cpp`, `Gamepad.cpp`, `Speech.cpp`,
    `PlatformResources.cpp` (WebCore's own images: broken image icon, text area corner)
  - `media/`: `<video>`/`<audio>`, MSE, MediaStream, MediaRecorder, WebCodecs, VideoFrame,
    `VideoOverlay.cpp` (holes of videos the host shows behind the canvas),
    `MediaCapabilitiesWasm.cpp` (`navigator.mediaCapabilities` of pages and workers with the
    host's answers); muted autoplay only in the view is a WebCore setting in `WebView.cpp`
  - `wasm/WasmBridge.cpp`: bridge between JSC and the pages' WebAssembly
  - `websocket/`: WebSockets of the pages over curl (from WebKitLegacy, WebKit license)

## Contract

The full list is `abi.json`; the rules behind it:

- Prefixes: `bl_*` exports are for the host. `bl__*` exports are internal, called only from
  `engine/js` or `engine/src`. The host never calls them.
- Strings into exports are UTF-8 allocated with `malloc` (`stringToNewUTF8`), the engine frees
  them. Strings and buffers handed to hooks are copies the host owns, except where `abi.json`
  says the host frees them (`_free`).
- Pointers in JS are unsigned numbers: the memory grows up to 4 GB, and above 2 GB a pointer
  arrives as a negative `i32` where Emscripten does not convert it. Every `EM_JS` function
  starts with `p >>>= 0;` for each pointer parameter (`tests/contract/pointers-test.mjs`, #465).
- Threads: `main()` runs on its own pthread, the engine thread (`-sPROXY_TO_PTHREAD`). Exports
  may be called from any thread and run asynchronously on the engine thread, unless
  `abi.json` marks them synchronous. Hooks run on the main thread of the page.
  `engineDialog` returns at once; only the asking page waits for `bl_dialog_answer`, the
  engine thread runs the other views meanwhile (#258). For `resubmit` (a form sent again) only
  the navigation waits; `dialog-cancel` withdraws it (#369).
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
  socket error that picks the error page. A request whose pooled connection closes before any
  response byte goes again on a new connection (patch 0078).
- Configuration: the environment (`Module.ENV` in `preRun`) is read once at the start of
  `main()` (`EngineConfig.cpp`). `BL_FEATURES` lists the host services a page may reach;
  a disabled feature looks like a browser without it, and no `__bl*` global is ever visible to
  page scripts. `BL_STORAGE_NAMESPACE` selects the OPFS directory of `/data` and the prefix of
  the Cache API names. `BL_ERROR_PAGE` replaces the error page template (below).
- `bl_load_url` puts `https://` in front of an address without a scheme; an address that is
  still invalid (a port above 65535, a space in the host) loads nothing, like in Chrome.
- Error page: shown under the failed address when a main frame navigation does not arrive:
  a web address that curl cannot load, a `file:` address without a file in the engine file
  system (`ERR_FILE_NOT_FOUND`), an `about:` address WebCore does not load (`ERR_INVALID_URL`),
  or an address WebCore refuses before the request, also as a redirect target: a restricted
  port (`ERR_UNSAFE_PORT`) or an address of only zeros (`ERR_ADDRESS_INVALID`). The engine's
  own requests (favicon, preconnect) never connect there; the error page loads no favicon.
  Redirects the engine stops get it under the address that redirected: more than 20
  (`ERR_TOO_MANY_REDIRECTS`) or one to a `file:` address (`ERR_UNSAFE_REDIRECT`).
  Like in Chrome, an answer with an HTTP error status (400 or more) and an empty body gets it
  too, kind `http` (`HTTP ERROR 500`, patch 0083); an error answer with a body shows that body.
  A `BL_ERROR_PAGE` template gets these placeholders, all HTML-escaped (unknown ones stay):
  `{{lang}}`, `{{kind}}` (`network`, `certificate` or `http`), `{{title}}` (the host),
  `{{heading}}`, `{{message}}`, `{{code}}` (e.g. `ERR_NAME_NOT_RESOLVED`), `{{url}}` and
  `{{retryLabel}}`.
  The engine inserts `<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  style-src 'unsafe-inline'; img-src data:">` at the start, after a leading doctype: no scripts
  and no external resources, inline styles and `data:` images only. A click on any
  `[data-bl-retry]` element retries (a listener the engine installs, the page needs no script).
  The `commit` event reports `errorPage: '<kind>'`.
- Crashes: a thread that traps or aborts writes its error with the stack into engine memory
  before the error event reaches the main thread; `Module.blCrashReason()` returns it.
- Shutdown: `Module.blShutdown()` closes all transport streams, terminates all engine threads
  and ends the main thread's wait for their messages, so the host can drop the module (a pending
  wait keeps the page alive in Firefox, #291).

Building: `tools/build-webcore.sh` ([docs/build.md](../docs/build.md)). Threads, storage, media
and GC in context: [docs/architecture.md](../docs/architecture.md).
