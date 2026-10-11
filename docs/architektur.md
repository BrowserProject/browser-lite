# Architektur

## Grosses Bild

```
Haupt-Thread (Seite browser-lite)            Engine-Worker (WASM, pthreads)
+--------------------------------+           +-------------------------------------+
| UI (TS): Tabs, Adressleiste    |  post-    | WasmWebView (unser Embedding)       |
| Canvas (OffscreenCanvas owner) |  Message  |   WebCore Page/Frame + Clients      |
| Input: Maus/Tastatur/Scroll/   | <-------> |   JavaScriptCore (CLoop)            |
|   Clipboard -> Events          |           |   Skia -> OffscreenCanvas (WebGL2)  |
+--------------------------------+           |   Netzwerk: WebCore curl-Backend    |
                                             |     libcurl + nghttp2 + OpenSSL     |
                                             |     Sockets -> Transport-Interface  |
                                             |   Storage: WasmFS + OPFS            |
                                             +------------------|------------------+
                                                                | Transport (austauschbar)
                                                                v
                                             WispTransport (jetzt) / WireGuardTransport (spaeter)
                                                                | WebSocket (wss)
                                                                v
                                             VPS: Caddy (Static + COOP/COEP) + Wisp-Relay (mit Auth)
```

## Die Teile

### WebKit-Port `PORT=Wasm`
WPE WebKit ist eigentlich multi-process (UI-, Web- und Network-Prozess mit IPC ueber
Unix-Sockets) und haengt an GLib und libsoup. Das passt nicht in WASM. Darum machen wir
einen eigenen kleinen Port:

- Basis ist der WebKit-Stand vom WPE-Release (siehe `versions.env`).
- Aufbau wie der PlayStation-Port: WTF `RunLoopGeneric` (kein GLib), WebCore curl-Backend
  fuer Netzwerk, statisch gelinkt.
- Grafik wie WPE: Skia (WPE nutzt seit 2.46 Skia statt Cairo).
- Kein WebKit2/IPC. WebCore laeuft single-process, wir binden `WebCore::Page` direkt an
  (aehnlich wie frueher WebKitLegacy).
- Ein neuer Port braucht in WebKit: Eintrag in `ALL_PORTS`, `Source/cmake/OptionsWasm.cmake`,
  und pro Projekt `PlatformWasm.cmake`. Unser Code dafuer liegt in `port/`, die noetigen
  Aenderungen an WebKit in `patches/webkit/`.

### JavaScript
JavaScriptCore mit dem **CLoop**-Interpreter (`ENABLE_JIT=OFF`, `ENABLE_C_LOOP=ON`).
In WASM kann man nicht einfach Maschinencode erzeugen, darum kein JIT. JS ist dadurch
langsamer als normal, einfache und mittlere Seiten gehen aber gut.

### Garbage Collector (wichtigstes Risiko)
JSC hat einen konservativen GC: er sucht auf dem Stack nach allem was wie ein Pointer
aussieht. In WASM gibt es zwei Stacks:

1. Den "Shadow-Stack" im Linear Memory (dort liegen Variablen deren Adresse genommen wird).
2. Die WASM-Locals der VM, die man **nicht** lesen kann.

Wenn ein Pointer auf ein JS-Objekt nur in einem WASM-Local liegt, sieht der GC ihn nicht
und kann das Objekt freigeben, obwohl es noch gebraucht wird. Das gibt seltene, schwer
reproduzierbare Abstuerze.

**Geloest in Phase 2** mit dem Binaryen-Pass `--spill-pointers` (Link-Flag
`-sBINARYEN_EXTRA_PASSES=--spill-pointers`): alle pointer-grossen Locals werden vor Calls auf
den Shadow-Stack geschrieben, und den scannt der GC sowieso. Nachweis mit
`tests/jsc/gc-stress.js` und `--slowPathAllocsBetweenGCs=10`: ohne Pass 0/5 Laeufe ok
(Absturz in `Structure::materializePropertyTable`), mit Pass 5/5 ok.

**Besser geloest in Phase 8:** Der Pass kostet sehr viel. In der Engine war das Erstellen
der ersten Seite 14x langsamer (4.6 s statt 0.33 s) und die .wasm 34 MB groesser. Die
Engine braucht ihn darum nicht mehr. Stattdessen laeuft der GC nur noch, wenn nichts von
JSC/WebCore auf dem Stack liegt:

- Jede Arbeit auf dem Engine-Thread (ein Schritt des Event-Loops, ein Aufruf aus der
  Oberflaeche) laeuft unter JSLock und einem `DeferGC` (`engine/src/EngineLoop.cpp`).
- Patch 0012: Auch explizite Anforderungen (`collectAsync`, `collectSync`) warten, solange
  ein `DeferGC` offen ist. Am Ende des aeussersten `DeferGC` laeuft der GC dann auf leerem
  Stack und findet alle Wurzeln im Speicher.
- Gleich fuer die Web Worker der Seiten (`WorkerRunLoop`) und den IndexedDB-Thread.

Nachweis: `tests/engine/gc-test.mjs` mit `JSC_slowPathAllocsBetweenGCs=10` (GC sehr oft).
Ohne die Verschiebung stuerzt der Test ab ("memory access out of bounds"), mit ihr laeuft er
durch. Nachteil: Waehrend einer einzelnen langen Aufgabe (z.B. eine JS-Schleife die viel
Speicher anlegt) laeuft kein GC. Der `jsc`-Test (Phase 2) nutzt weiter `--spill-pointers`,
weil dort ein ganzes Skript eine einzige Aufgabe ist.

Ausserdem: `Thread::suspend` geht in WASM nicht (keine Signale). Darum pro JS-VM nur ein
Thread, Sampling-Profiler aus.

### Rendering
- Zuerst Skia CPU-Raster in einen Buffer, dann als ImageBitmap auf das Canvas.
- Spaeter Skia Ganesh auf WebGL2 im OffscreenCanvas mit Compositing (Scrollen ohne neu
  malen).

### Netzwerk
- WebCore curl-Backend (`Source/WebCore/platform/network/curl/`), libcurl mit nghttp2
  (HTTP/2) und OpenSSL (das curl-Backend von WebCore nutzt direkt die OpenSSL-API).
- libcurl denkt es hat normale Sockets. Unsere Socket-Schicht leitet `connect/send/recv/poll`
  an ein **Transport-Interface** weiter (`engine/net/transport.h`).
- `WispTransport`: jede TCP-Verbindung ist ein Stream in einer Wisp-WebSocket-Verbindung.
  Hostnamen werden vom Relay aufgeloest.
- Spaeter `WireGuardTransport`: userspace TCP/IP + WireGuard im WASM, UDP-Pakete ueber
  Wisp-UDP. WebCore und curl merken davon nichts.

### Threads
Emscripten pthreads, braucht `SharedArrayBuffer`. Dafuer muss die Seite mit diesen Headern
ausgeliefert werden:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Speicher
Cookies (SQLite), localStorage und IndexedDB liegen in der Engine unter `/data`. Das ist ein
IDBFS von Emscripten: beim Start aus der IndexedDB des Host-Browsers geladen, danach alle
5 s und beim Verlassen der Seite zurueckgeschrieben. Bleibt also zwischen Besuchen erhalten.

### Ton (Web Audio)
```
Seite (JS in der Engine)            Engine                          Host-Browser
AudioContext, Oszillator, ...  ->   Thread "WebAudio Wasm"     ->   AudioWorklet liest den
                                    rendert in Ringpuffer im        Ring und gibt ihn an das
                                    gemeinsamen WASM-Speicher       echte Web Audio weiter
```
- `platform/audio/wasm/AudioDestinationWasm.cpp`: rendert immer ca. 64 ms im Voraus. Der Ring
  hat zwei Zaehler (geschrieben/gelesen) und einen Herzschlag, das Worklet (`web/audio-worklet.js`)
  liest ohne Locks.
- Chrome erlaubt Ton erst nach einem Klick. Bis dahin rendert die Engine im Takt der Uhr
  weiter und wirft den Ton weg, `currentTime` laeuft also wie in einem normalen Browser.
- `decodeAudioData`: die Daten gehen an den Dekoder des Host-Browsers (MP3, AAC, Opus, ...),
  der Hintergrund-Thread der Engine wartet so lange.
- FFT (Analyser, Convolver, Oszillator-Tabellen): eigene Radix-2-FFT (`FFTFrameWasm.cpp`).
- HRTF-Daten fuer den PannerNode liegen in `engine.data`.

### Video und Audio-Elemente
```
Seite: <video src=...>        Engine (media/)                 Oberflaeche (media.js, sw.js)
HTMLMediaElement  ->  MediaPlayerPrivateWasm  --create-->  verstecktes <video src=bl-media/..>
                                                                 | Range-Anfrage
                      MediaFetch (curl, Range)  <--------  Service Worker (2-MB-Stuecke)
                      malt das Bild in die Seite <--------  Bild (drawImage) in WASM-Speicher
```
- Zustand (Zeit, Dauer, readyState, buffered) meldet die Oberflaeche bei jedem Event des
  Host-`<video>`, dazwischen rechnet die Engine die Zeit selber weiter.
- MSE: WebCore bekommt Spuren und Zeitstempel aus `ContainerParser` (fMP4, WebM) und macht
  daraus `buffered`, Springen und Speicherverwaltung. Die gleichen Bytes gehen an ein
  MediaSource im Host, das dekodiert. `readyState` ist das Minimum von beiden.
- Der Ton kommt direkt aus dem Host-`<video>`. Chrome erlaubt Ton erst nach einem Klick, stumme
  Videos duerfen sofort laufen (wie in einem normalen Browser).

### Hosting
Auf dem VPS mit Docker Compose: Caddy (HTTPS, die Header oben, Brotli) und das Wisp-Relay.
Das Relay braucht Auth (sonst nutzen fremde Leute den Server als Proxy) und blockiert
private IP-Bereiche.
