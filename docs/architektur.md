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

**Aufruf-Caches:** JSC schaltet auf 32-Bit-Systemen alle ICs ab (`forceICFailure`), und
WASM ist 32 Bit. Darum ging jeder JS-Funktionsaufruf durch `llint_default_call` in C++
(gemessen: 300 000 Aufrufe = 300 000 Mal der langsame Weg). Der Interpreter hat aber eigene
Aufruf-Caches (ein Ziel, mehrere Ziele, Closures), die auch auf 32 Bit gehen. Patch 0019
schaltet sie ein. Gewinn im Benchmark (`tests/engine/jsbench.html`, bester von 5 Laeufen):
Aufrufe -37 %, Klassen -40 %, Arrays mit Callbacks -30 %, Closures -30 %. Test:
`tests/jsc/calls.js`.

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
durch. Der `jsc`-Test (Phase 2) nutzt weiter `--spill-pointers`, weil dort ein ganzes
Skript eine einzige Aufgabe ist.

**GC an sicheren Punkten:** Ohne mehr laeuft waehrend einer einzelnen langen Aufgabe (ein
grosses Skript beim Laden) kein GC. Der Muell sammelte sich bis zum Ende, und weil der
WASM-Speicher nie schrumpft, blieb die Spitze fuer immer. Darum (auch Patch 0012): will der
Heap sammeln, waehrend aufgeschoben ist, setzt er einen eigenen VM-Trap. Den bedient nur der
Interpreter bei `op_check_traps`, also an einer Befehlsgrenze, wo alle Werte im JS-Stack von
JSC im Speicher liegen. Gesammelt wird nur, wenn JS direkt aus der Engine kam (genau ein
VM-Einstieg, kein C++ dazwischen) und nichts ausser dem `DeferGC` der Engine aufschiebt.
Abschalten mit `?safepointgc=0`, Ausgabe mit `?safepointgc=debug`.

**Freigeben bei hohem Verbrauch:** Nach einer Aufgabe prueft die Engine hoechstens alle 5 s
den belegten malloc-Speicher. Ab 192 MB (und wenn seit der letzten Freigabe 64 MB dazukamen)
ruft sie `WebCore::releaseMemory` auf, das sonst nur bei Speicherdruck laeuft: Caches,
dekodierte Bilder, Back/Forward-Cache, kompilierter Code, danach ein voller GC. Gemessen
(CNN, Microsoft, YouTube, Wikipedia nacheinander): 220 -> 170 MB und 248 -> 146 MB, je ca.
0.3 s. Schwelle mit `BL_MEMORY_RELEASE_MB` (0 = aus).

Ausserdem: `Thread::suspend` geht in WASM nicht (keine Signale). Darum pro JS-VM nur ein
Thread, Sampling-Profiler aus.

### Rendering
- Zuerst Skia CPU-Raster in einen Buffer, dann als ImageBitmap auf das Canvas.
- Spaeter Skia Ganesh auf WebGL2 im OffscreenCanvas mit Compositing (Scrollen ohne neu
  malen).

### WebGL
- WebKits `GraphicsContextGLANGLE` ruft ANGLE-Funktionen auf (`GL_DrawArrays`, `EGL_...`).
  ANGLE selber wird nicht gebaut. Stattdessen gibt es einen kleinen Ersatz in
  `platform/wasm/angle/` (Patch 0016): `tools/gen-angle-shim.py` sucht die benutzten
  Funktionen und leitet sie an Emscriptens GLES weiter, also an ein echtes WebGL des
  Host-Browsers auf einem OffscreenCanvas im Engine-Worker. Was es in WebGL nicht gibt oder
  anders heisst (Erweiterungen, Robust-Varianten, Formate in WebGL 1) ist von Hand gemacht.
- WebGL-1-Seiten bekommen einen WebGL-1-Kontext, WebGL-2-Seiten einen WebGL-2-Kontext. So
  stimmen Shader-Versionen und Grenzen ohne Uebersetzung. Der Shader-Compiler von WebKit (ANGLE
  Translator) laeuft nicht, die Shader gehen direkt an den Browser, der sie selber prueft.
- Chrome erlaubt in einem Worker nur 4 aktive WebGL-Kontexte (danach geht der aelteste
  verloren). Darum teilen sich alle WebGL-Kontexte der Engine einen echten Kontext pro
  WebGL-Version, wie die virtualisierten Kontexte von ANGLE: beim Wechsel speichert
  `ANGLEShimWasm.cpp` den GL-Zustand (Schalter, Bindungen, Textur-Einheiten, Pixel-Store,
  Uniform-Puffer, ...) und laedt den des anderen Kontexts. Jeder Kontext hat ein eigenes
  "Standard"-VAO und Transform-Feedback-Objekt, und Textur-Einheiten, die ein Kontext nie
  benutzt hat, werden geleert. So sieht keine Seite Daten einer anderen.
- Bild in die Seite: nach jedem Frame liest `GraphicsContextGLWasm` die Pixel mit
  `readPixels` (kein Compositing, siehe Entscheid 26).

### WebAssembly der Seiten
JSC kann mit dem C-Loop-Interpreter kein WebAssembly (der Wasm-Interpreter von JSC hat
keinen C-Loop-Modus). Die Module der Seiten laufen darum in der echten WASM-Engine des
Browsers, mit voller Geschwindigkeit, SIMD, Ausnahmen usw.:

- `engine/js/wasm-guest.js` baut die API `WebAssembly` in JSC nach (Module, Instance,
  Memory, Table, Global, Tag, Exception, compile/instantiate(Streaming), Fehlerklassen).
  Sie wird erst beim ersten Zugriff auf `WebAssembly` ausgewertet, in Fenstern und in
  Workern/Worklets (Hook in WebCore, Patch 0018).
- `engine/src/wasm/WasmBridge.cpp` ist die Bruecke: Werte gehen als Paare [Typ, Wert]
  bzw. als 16-Byte-Slots im Speicher der Engine hin und her. Werte aus JSC (z.B. Funktionen
  fuer Imports, externref) bekommen eine id, Objekte des Browsers (Funktionen, Tabellen,
  Globals) auch.
- `engine/js/wasm-host.js` fuehrt die Module im Engine-Worker aus. Imports aus JS rufen
  ueber `bl_wasm_call_guest` zurueck in JSC, Ausnahmen gehen in beide Richtungen durch.
- Speicher: JavaScript der Seite muss `memory.buffer` direkt sehen, der ArrayBuffer muss
  also im Speicher der Engine liegen. Darum schreibt `engine/js/wasm-rewrite.js` jedes Modul
  vor dem Kompilieren um: Speicher 0 wird der Speicher der Engine, jeder Zugriff bekommt
  eine Grenzpruefung und die Basis des eigenen Bereichs dazu. memory.grow ruft die Bruecke,
  die den Bereich bei Bedarf umzieht (der alte ArrayBuffer wird abgehaengt, wie im Standard).
  Basis und Groesse liegen pro Funktion in Locals und werden nur nach Aufrufen neu geladen.
  Kostet ca. 10-15 % Geschwindigkeit, dafuer kann ein Modul nur seinen eigenen Bereich
  lesen und schreiben.

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
