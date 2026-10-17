# engine/

Unser Embedding von WebCore: das Programm `engine.js`/`engine.wasm`, das die Oberflaeche
(`web/`) startet. Was zwingend in WebKit selber muss (Port `PORT=Wasm`, Plattform-Code unter
`Source/WebCore/platform/wasm/`), kommt als Patch aus `patches/webkit/`.

- `engine.cmake`: wird vom WebKit-Build eingebunden (Patch 0006, `PlatformWasm.cmake`). Quellen,
  Link-Optionen, Datenpaket `engine.data`, Build-ID (`tools/wasm-build-id.py`). `BL_PRE_JS` ist
  die einzige Liste der `--pre-js`-Dateien.
- `js/`: JS-Teile der Engine, laufen im Engine-Worker
  - `engine-pre.js`: Anbindung an die Oberflaeche (`Module.onEngine*`), Canvas, Hilfen
  - `wasm-rewrite.js`, `wasm-host.js`: WebAssembly der Seiten in der WASM-Engine des Browsers;
    `wasm-guest.js` ist die API `WebAssembly` fuer die Seiten und laeuft in JSC (Datenpaket)
  - `sockets.js`: TCP-Verbindungen ueber den Transport der Oberflaeche
  - `http-cache.js`, `bytecode-cache.js`: HTTP- und Bytecode-Cache in der Cache API des Host
  - `webcodecs-host.js`, `mediarecorder-host.js`: WebCodecs und MediaRecorder mit den Codecs
    des Host (WebM-Muxer)
  - `wasmfs-opfs.js` (`--js-library`): ersetzt das Schreiben des OPFS-Backends von WasmFS,
    "kein Platz" im Host kommt als `ENOSPC` an
- `src/`: C++ der Engine
  - Start und Ablauf: `main.cpp`, `Engine.h`, `EngineLoop.cpp` (Event-Loop, Watchdog),
    `Exports.cpp` (C-Schnittstelle `bl_*` fuer die Oberflaeche), `Host.cpp` (Events an die
    Oberflaeche)
  - Tabs: `WebView.cpp` (Page, Eingabe, Rendern), `Clients.cpp`, `EditorClient.cpp`,
    `BackForwardList.cpp`, `Choosers.cpp` (select, Farbe, Datum), `Printing.cpp`,
    `PinchZoom.h`
  - Grafik: `GpuRaster.cpp` (Skia ueber WebGL 2), `LayerTreeHostWasm.cpp` und `Compositor.cpp`
    (Ebenen im Compositor-Thread), `ScrollingWasm.cpp` (Scrollen im eigenen Thread)
  - Netz: `LoaderStrategy.cpp` (Laden mit curl, Downloads, Ping), `Sockets.cpp`, `HttpCache.cpp`,
    `BytecodeCache.cpp`, `PlatformStrategies.cpp`, `Strategies.h` (Cookies)
  - Speicher: `Storage.cpp` (Cookies, localStorage, IndexedDB unter `/data`), `MemoryVFS.cpp`
    (SQLite), `CacheStorageWasm.cpp`, `FileSystemStorageWasm.cpp` (OPFS), `FileAccessCache.cpp`
  - Worker und Plattform: `ServiceWorkerWasm.cpp` (Service Worker, SharedWorker),
    `WebPlatformExtras.cpp` (Polyfills ueber den Host), `WebRTCPolyfill.cpp`,
    `DeviceClients.cpp` und `Permissions.cpp` (Berechtigungen, Standort, Benachrichtigungen,
    Kamera), `Gamepad.cpp`, `Speech.cpp`
  - `media/`: `<video>`/`<audio>` und MSE im Host-Video (`MediaPlayerPrivateWasm`,
    `MediaSourceWasm`, `ContainerParser`, `MediaFetch`), `MediaStreamWasm`, `MediaRecorderWasm`,
    `WebCodecsWasm`, `VideoFrameWasm`
  - `wasm/WasmBridge.cpp`: Bruecke zwischen JSC und WebAssembly der Seiten
  - `websocket/`: WebSockets der Seiten ueber curl (`WebSocketChannel` und `SocketStreamHandle`
    aus WebKitLegacy, mit Lizenzkopf von WebKit)

Bauen: `tools/build-webcore.sh` ([docs/build.md](../docs/build.md)). Aufbau und Threads:
[docs/architektur.md](../docs/architektur.md).
