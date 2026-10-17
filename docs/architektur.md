# Architektur

## Grosses Bild

```
Haupt-Thread (Oberflaeche, web/)          Engine-Worker (WASM, pthreads, je ein Web Worker)
+--------------------------------+         +------------------------------------------+
| app.js: Tabs, Adressleiste,    |  post-  | Engine-Thread: WebView (unser Embedding) |
|   Eingabe -> bl_*-Exporte      | Message |   WebCore Page/Frame + Clients           |
| watchdog.js: Absturz, Haengen  | <-----> |   JavaScriptCore (CLoop), Loader (curl)  |
| transport.js: Wisp-Client      |         | Compositor-Thread: Ebenen, Pinch-Zoom,   |
| media.js, sw.js, devices.js,   |         |   WebGL 2, besitzt die Canvas der Tabs   |
|   capture.js, webrtc.js        |         | Scroll-Thread, Kachel-Maler, curl,       |
+--------------------------------+         |   Web Worker der Seiten, Audio, ...      |
                                           | Speicher: WasmFS, /data im OPFS          |
                                           +--------------------|---------------------+
                                                                | Sockets (engine/js/sockets.js)
                                                                v
                                           Transport der Oberflaeche: Wisp (jetzt) / WireGuard (spaeter)
                                                                | WebSocket (wss)
                                                                v
                                           Server: ein Container (Seite + COOP/COEP + Wisp-Relay)
```

## Die Teile

### Oberflaeche
Schlichtes HTML, CSS und JavaScript (ES-Module) ohne Build-Schritt, ein Modul pro Thema
([web/README.md](../web/README.md)). Gemeinsame Helfer (Speicher, Base64, Fehler) liegen in
`web/util.js`. Die Engine ruft die Oberflaeche ueber `Module.*`-Funktionen und Ereignisse wie
`navigation`, `commit`, `external-url` auf, die Oberflaeche die Engine ueber `bl_*`-Exporte.

- Absturz und Haengen (`web/watchdog.js`): eine Engine fuehrt alle Tabs. Bricht sie ab
  (`Module.onAbort`, WASM-Trap, Fehler aus einem ihrer Threads), kommt eine Meldung mit
  "Neu starten", die Sitzung bringt den letzten guten Stand zurueck. Vor Aufrufen, auf die die
  Engine immer antwortet (Laden, Neu laden, Verlauf wiederherstellen, Suchen), ruft `app.js`
  `expectAnswer()`; nach Klicks und Tasten schickt sie eine Marke (`inputSent`), die der
  Engine-Thread nach der Eingabe im Speicher ablegt. Bleibt die Antwort bzw. Marke 10 s aus,
  gibt es "Warten" oder "Neu starten" (Entscheide 147, 172).
- Dialoge (`alert`/`confirm`/`prompt`) sind die echten Dialoge des Host mit dem Host der Seite
  davor, Hintergrund-Tabs bekommen sofort eine Antwort (Entscheid 149), unterdrueckte Dialoge
  zeigt ein Zeichen am Tab. beforeunload fragt mit den Texten von Chrome (Entscheid 168).
- Nur der aktive Tab ist fuer seine Seite sichtbar, und nur solange der Tab des Host es ist
  (`bl_set_visible`, Entscheid 170). Meldet die Engine `memory-pressure`, verwirft die
  Oberflaeche den am laengsten nicht benutzten Hintergrund-Tab (Entscheid 171).
- `mailto:`, `tel:` und andere fremde Schemata gibt die Engine nach einem Klick als
  `external-url` an die Oberflaeche, die sie mit `window.open(..., 'noopener')` an den Host
  gibt (Entscheid 148).
- `navigator.onLine` der Seiten: Netz des Host und Verbindung zum Relay (`bl_set_online`,
  Entscheid 158).

### WebKit-Port `PORT=Wasm`
WPE WebKit ist eigentlich multi-process (UI-, Web- und Network-Prozess mit IPC ueber
Unix-Sockets) und haengt an GLib und libsoup. Das passt nicht in WASM. Darum machen wir
einen eigenen kleinen Port:

- Basis ist der WebKit-Stand vom WPE-Release (siehe `versions.env`).
- Aufbau wie der PlayStation-Port: WTF `RunLoopGeneric` (kein GLib), WebCore curl-Backend
  fuer Netzwerk, statisch gelinkt.
- Grafik wie WPE: Skia.
- Kein WebKit2/IPC. WebCore laeuft single-process, wir binden `WebCore::Page` direkt an
  (aehnlich wie WebKitLegacy). Was in WebKit2 im Network-Prozess steckt (Service Worker,
  Cache API, OPFS, Downloads), baut `engine/src/` direkt im Engine-Thread nach.
- Ein neuer Port braucht in WebKit: Eintrag in `ALL_PORTS`, `Source/cmake/OptionsWasm.cmake`,
  und pro Projekt `PlatformWasm.cmake` (Patch 0006). Alle Aenderungen an WebKit liegen als
  Patches in `patches/webkit/`, unser Embedding (WebView, Clients, Exporte) in `engine/`.

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

**Watchdog:** alle Tabs teilen sich den Engine-Thread. Ein Einstieg in JS (Skript,
Event-Handler, Timer) darf darum hoechstens 30 s laufen, dann bricht ihn JSCs Watchdog mit
einer nicht abfangbaren TerminationException ab, die Seite bekommt eine Meldung in der Konsole
(`engine/src/EngineLoop.cpp`, `BL_SCRIPT_TIMEOUT`, 0 = aus). Geprueft wird an `op_check_traps`,
gemessen die Uhrzeit; die Zeit in `alert`/`confirm`/`prompt` zaehlt nicht. Gilt fuer die
Fenster aller Tabs (`commonVM()`), nicht fuer Web Worker der Seiten, die eigene Threads haben.
Test: `tests/engine/hang.html` (Entscheid 146).

### Garbage Collector (wichtigstes Risiko)
JSC hat einen konservativen GC: er sucht auf dem Stack nach allem was wie ein Pointer
aussieht. In WASM gibt es zwei Stacks:

1. Den "Shadow-Stack" im Linear Memory (dort liegen Variablen deren Adresse genommen wird).
2. Die WASM-Locals der VM, die man **nicht** lesen kann.

Wenn ein Pointer auf ein JS-Objekt nur in einem WASM-Local liegt, sieht der GC ihn nicht
und kann das Objekt freigeben, obwohl es noch gebraucht wird. Das gibt seltene, schwer
reproduzierbare Abstuerze.

**GC nur auf leerem Stack:** der Binaryen-Pass `--spill-pointers` (alle pointer-grossen Locals
vor Calls auf den Shadow-Stack) loest das, kostet aber sehr viel (erste Seite 14x langsamer,
.wasm 34 MB groesser). Nur der `jsc`-Test nutzt ihn, weil dort ein ganzes Skript eine einzige
Aufgabe ist (Nachweis mit `tests/jsc/gc-stress.js`). Die Engine laesst den GC stattdessen nur
laufen, wenn nichts von JSC/WebCore auf dem Stack liegt:

- Jede Arbeit auf dem Engine-Thread (ein Schritt des Event-Loops, ein Aufruf aus der
  Oberflaeche) laeuft unter JSLock und einem `DeferGC` (`engine/src/EngineLoop.cpp`).
- Patch 0012: Auch explizite Anforderungen (`collectAsync`, `collectSync`) warten, solange
  ein `DeferGC` offen ist. Am Ende des aeussersten `DeferGC` laeuft der GC dann auf leerem
  Stack und findet alle Wurzeln im Speicher.
- Gleich fuer die Web Worker der Seiten (`WorkerRunLoop`) und den IndexedDB-Thread. Die Web
  Worker laufen wie der Engine-Thread aus dem Event-Loop des Host (Patch 0041, Entscheid 183),
  darum feuern dort FinalizationRegistry und WeakRefs der Host-Seite.

Nachweis: `tests/engine/gc-test.mjs` mit `JSC_slowPathAllocsBetweenGCs=10` (GC sehr oft).
Ohne die Verschiebung stuerzt der Test ab ("memory access out of bounds"), mit ihr laeuft er
durch.

**GC an sicheren Punkten:** Ohne mehr laeuft waehrend einer einzelnen langen Aufgabe (ein
grosses Skript beim Laden) kein GC. Der Muell sammelte sich bis zum Ende, und weil der
WASM-Speicher nie schrumpft, blieb die Spitze fuer immer. Darum (auch Patch 0012): will der
Heap sammeln, waehrend aufgeschoben ist, setzt er einen eigenen VM-Trap. Den bedient nur der
Interpreter bei `op_check_traps` und beim Funktionseintritt, also an einer Befehlsgrenze, wo
alle Werte im JS-Stack von JSC im Speicher liegen. Gesammelt wird nur, wenn JS direkt aus der
Engine kam (genau ein VM-Einstieg, kein C++ dazwischen) und nichts ausser dem `DeferGC` der
Engine aufschiebt. Abschalten mit `?safepointgc=0`, Ausgabe mit `?safepointgc=debug`.

**Freigeben bei Wachstum:** Nach jeder Aufgabe schaut die Engine, wie gross der Bereich ist,
den malloc vom System geholt hat (`malloc_footprint()`, kostet nichts). Ab 192 MB ruft sie bei
jedem Wachstum um 32 MB `WebCore::releaseMemory` auf, das sonst nur bei Speicherdruck laeuft:
Caches, dekodierte Bilder, Back/Forward-Cache, kompilierter Code, danach ein voller GC. So
wird zuerst der frei gewordene Platz wiederverwendet, bevor der WASM-Speicher waechst.
Gemessen (CNN, Microsoft, YouTube, Wikipedia nacheinander): WASM-Speicher am Ende 369 MB statt
443 MB, jede Freigabe 0.1-0.3 s. Schwelle mit `BL_MEMORY_RELEASE_MB` (0 = aus).

Ausserdem: `Thread::suspend` geht in WASM nicht (keine Signale). Darum pro JS-VM nur ein
Thread, Sampling-Profiler aus.

### Rendering
- Skia rastert per Ganesh auf WebGL 2 im Engine-Worker (Entscheid 86), ohne WebGL 2 oder mit
  `?gpu=0` auf der CPU. Fuer die CPU baut Patch 0020 Skia mit `-msse4.1`: Emscripten bildet
  SSE bis 4.1 auf WASM-SIMD ab, sonst naehme Skia die skalare Pipeline (ein Pixel pro
  Schritt). Malen von `tests/engine/paintbench.html` (1280x2000): 907 -> ca. 430 ms.
- Compositing mit Ebenen wie WPE (Coordinated Graphics, `engine/src/LayerTreeHostWasm.cpp`):
  der Engine-Thread macht Rendering-Update und flush, die Kacheln malen Hintergrund-Threads,
  ein eigener Compositor-Thread (`engine/src/Compositor.cpp`) setzt die Ebenen mit eigenem
  WebGL-2-Kontext zusammen und zeigt das Bild im Canvas des Tabs, das ihm gehoert
  (`transferControlToOffscreen`). Animationen von `transform`/`opacity` laufen so weiter,
  auch wenn JS den Engine-Thread blockiert. `?compositing=0` schaltet ab.
- Scrollen laeuft im Scroll-Thread von WebCore (`engine/src/ScrollingWasm.cpp`): Rad- und
  Wisch-Events gehen ueber den Compositor-Thread direkt dorthin (Entscheid 101).
- Pinch-Zoom: waehrend der Geste skaliert der Compositor die gezeigten Kacheln (Transformation
  der Wurzel-Ebene, Rechnung in `engine/src/PinchZoom.h`), am Ende uebernimmt der Engine-Thread
  einmal mit `Page::setPageScaleFactor` (Entscheid 150). Strg + Rad geht vorher an die Seite,
  gezoomt wird nur ohne `preventDefault` (Entscheid 167).
- CSS-Filter: Blur und Schatten rechnet der Compositor auf der GPU, eine Ebene ohne Kinder
  behaelt ihr gefiltertes Bild, solange sich nichts aendert (Patch 0036, Entscheid 156).
  `url()`- und SVG-Filter malt die CPU in den Kacheln.
- GPU-Verlust: der Engine-Worker malt bis zum `webglcontextrestored` auf der CPU, danach
  registriert er denselben WebGL-Kontext neu und malt wieder auf der GPU. Ohne Compositor
  kommen alle Views zurueck, mit Compositor nur neue Views mit Ebenen (Entscheid 157). Im Log:
  `GPU: Views wieder auf der GPU: <n>`.

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
  `readPixels`; ohne Compositing malt die Engine sie in die Seite, mit Compositing werden sie
  Inhalt einer Ebene.
- Kontextverlust: ein Kontext bleibt an seinem verlorenen Host-Kontext, bis er zerstoert wird,
  und meldet `webglcontextlost` beim naechsten `clear` oder Zeichnen (`checkGPUStatus`). Nach
  `preventDefault` macht WebKit einen neuen Kontext auf einem neuen Host-Kontext. Nie synchron
  aus `makeContextCurrent` melden: WebGL haelt dabei oft `objectGraphLock`.

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
- Realms: alles gehoert dem globalen Objekt der Seite (eines Frames oder Workers). Die Werte,
  die die Host-Seite haelt, haengen an einem privaten Symbol am globalen Objekt (fuer die
  Seite unsichtbar) und sind keine GC-Wurzeln. Stirbt das globale Objekt (Navigation, Ende
  eines Workers), gibt die Bruecke die Speicher der Realm frei und die Host-Seite ihre Objekte.
  Speicher-Funktionen nehmen nur Speicher der eigenen Realm an, auch im Host
  (`wasm-host.js`). Der Zustand der Bruecke lebt pro Thread bis zu dessen Ende.
- `engine/js/wasm-host.js` fuehrt die Module im Engine-Worker aus. Imports aus JS rufen
  ueber `bl_wasm_call_guest` zurueck in JSC, Ausnahmen gehen in beide Richtungen durch.
  Hoechstens 64 verschachtelte Aufrufe JS -> WebAssembly -> JS (Chrome lief nach ca. 125
  ueber), dann ein RangeError.
- Speicher: JavaScript der Seite muss `memory.buffer` direkt sehen, der ArrayBuffer muss
  also im Speicher der Engine liegen. Darum schreibt `engine/js/wasm-rewrite.js` jedes Modul
  vor dem Kompilieren um: jeder Speicher des Moduls wird ein eigener Bereich im Speicher der
  Engine, jeder Zugriff bekommt eine Grenzpruefung und die Basis des Bereichs dazu.
  memory.grow ruft die Bruecke, die den Bereich bei Bedarf umzieht (der alte ArrayBuffer wird
  abgehaengt, wie im Standard), mit einem Viertel Reserve, hoechstens 96 MB. Jeden Bereich
  meldet die Bruecke dem GC von JSC als Extra-Speicher (Entscheid 184). Basis und Groesse
  liegen pro Funktion in Locals und werden nur nach Aufrufen neu geladen. Kostet ca. 10-15 % Geschwindigkeit, dafuer kann ein Modul nur
  seine eigenen Bereiche lesen und schreiben. Hoechstens 2 GB pro Speicher, `memory.buffer`
  laesst sich nicht uebertragen.
- memory64 und mehrere Speicher gehen (i64-Adressen werden geprueft und auf i32 gekuerzt,
  Entscheid 152). Geteilter Speicher (Threads) und JSPI nicht, `validate()` sagt dafuer false
  und `atomic.wait` trapt (Entscheid 153).

### Netzwerk
- WebCore curl-Backend (`Source/WebCore/platform/network/curl/`), libcurl mit nghttp2
  (HTTP/2) und OpenSSL (das curl-Backend von WebCore nutzt direkt die OpenSSL-API).
- libcurl denkt es hat normale Sockets. Die Socket-Funktionen (`socket/connect/send/recv/
  poll/close/...`, die Weck-Pipe von curl und `getaddrinfo`) werden beim Linken abgefangen
  (`-Wl,--wrap=...`, `engine/src/Sockets.cpp`). Puffer und Warten (Condition-Variable) liegen
  im WASM. Nur Verbindung oeffnen, Daten senden und schliessen gehen asynchron an den
  Haupt-Thread (`engine/js/sockets.js`), der sie ueber den **Transport** der Oberflaeche
  schickt (`Module.blTransport`, heute Wisp aus `web/transport.js`). Ankommende Daten
  schreibt der Haupt-Thread direkt in den Puffer. Gesendet gilt erst, was der Transport
  abgeschickt hat (`onsent`, `bl_socket_sent`), hoechstens 8 MB sind unterwegs. Schliesst das
  Relay mit einem Fehlergrund, bekommt curl einen Fehler (errno) statt eines normalen Endes,
  ohne Relay ENETUNREACH. Patch 0039 macht aus dem errno den Code von curl (Entscheid 175).
  Ein Deskriptor lebt, solange ihn ein Thread benutzt (`shared_ptr`).
  `getaddrinfo` gibt fuer Hostnamen Platzhalter (172.29.x.y), `connect` macht daraus wieder
  den Namen, aufloesen tut das Relay.
- Wichtig fuer allen Code, der auf dem Haupt-Thread laeuft: waehrend er auf ein Lock wartet
  (auch das von malloc), arbeitet Emscripten die Warteschlange des Haupt-Threads ab. Haelt er
  dabei schon ein Lock, das eine dieser Aufgaben auch nimmt, wartet er auf sich selber. Das
  liess Seiten wie nzz.ch ab und zu haengen. Darum: auf dem Haupt-Thread unter einem Lock
  nichts, was warten kann (kein malloc/free).
- Loader (`engine/src/LoaderStrategy.cpp`): alle Ladewege (Seiten-Ressourcen, Pings und
  Beacons, Favicons, Downloads, Media, Soft-Update und Navigation Preload der Service Worker)
  bauen ihre Anfrage mit denselben Helfern (`createCurlRequest`, `storeCookies`,
  `followRedirect`, `networkResponse`): Cookies nur bei `allowCookies` (also nicht bei
  `credentials: 'omit'`), Redirects hoechstens 20, nie nach `file:`, ohne Zugangsdaten und
  ohne Authorization/Origin bei fremdem Ursprung. Pings pruefen wie WebKit2 CORS (mit
  Preflight) und CSP auch nach Redirects. Downloads siehe Entscheid 163. curl hat hoechstens
  64 Verbindungen, 6 pro Host (Entscheid 176).
- Fehlerseite (`engine/src/ErrorPage.cpp`): scheitert die Navigation des Hauptframes in curl,
  laedt die Engine eine Seite wie Chrome unter der Adresse, die nicht ging (Entscheid 174).
- TLS: ChaCha20-Poly1305 zuerst (TLS 1.3 ueber `CURLOPT_TLS13_CIPHERS`, Patch 0021, und
  TLS 1.2). In WASM gibt es keine AES-Hardware; AES-GCM in Software kostete auf CNN 1.6 s
  auf dem curl-Thread, ChaCha20 0.38 s. Server folgen meist der Reihenfolge des Clients, wenn
  der ChaCha bevorzugt (wie Handys ohne AES-Befehle).
- HTTP-Cache: ohne Network-Prozess hat WebKit nur den Speicher-Cache, der mit der Engine
  verschwindet. `engine/src/HttpCache.cpp` legt cachebare Antworten (bis 10 MB) in die Cache
  API des Host-Browsers (`bl-http-v2`, auf der Platte, wird nur bei Bedarf gelesen, Zugriff
  ueber `engine/js/http-cache.js` auf dem Haupt-Thread; die URL-Liste haelt der Haupt-Thread im
  Speicher, Anfragen ohne Eintrag kosten so keinen Plattenzugriff). Vor dem Netz: frisch ->
  direkt aus dem Cache, alt mit ETag/Last-Modified -> bedingte Anfrage, bei 304 aus dem Cache
  (`lookupForLoad`, `didRevalidate`, fuer alle Lader, Entscheid 182).
  Frische, Alter und Vary rechnet WebCore (`CacheValidation.h`). Gezaehlt wird nur der eigene
  Inhalt (Header `x-bl-size`), Grenze 400 MB und hoechstens ein Viertel der Quote, darueber
  werden die aeltesten Eintraege bis 80 % geloescht (auch bei voller Quote). HTTP/1-Antworten,
  die nur mit der Verbindung enden, kommen nicht hinein (ein Abbruch saehe aus wie ein Ende).
  "Gespeicherte Daten loeschen" leert ihn mit. Gemessen beim zweiten Besuch: GitHub 135 von 136
  Anfragen aus dem Cache, CNN 123 (davon 103 mit 304). Test: `tests/e2e/cache-test.mjs`,
  `tests/engine/http-cache-test.mjs`.
- WebCrypto (`crypto.subtle`) ueber den OpenSSL-Code von WebCore. Zwei Stellen gingen mit
  OpenSSL 3 nicht und sind in Patch 0010 repariert: AES-GCM (Padding wurde vor dem Init
  gesetzt) und RSA-OAEP/RSA-PSS (WebKit prueft mit `#if defined(...)` auf Makros, die in
  OpenSSL 3 Funktionen sind). Bot-Pruefungen wie AWS WAF brauchen AES-GCM. Ed25519/X25519
  mit eigenem OpenSSL-Code (EVP, auch Patch 0010, Entscheid 73). Test:
  `tests/engine/crypto.html`.
- `WispTransport`: jede TCP-Verbindung ist ein Stream in einer Wisp-WebSocket-Verbindung.
  Hostnamen werden vom Relay aufgeloest. Jeder WebSocket macht seinen eigenen Handshake (15 s
  Zeitlimit). Bricht eine stehende Verbindung ab, verbindet er einmal sofort neu, sonst alle
  2 s, und meldet `connected` fuer `navigator.onLine`. Kommt 10 s nach dem Senden nichts
  zurueck, fragt er beim Relay nach und verwirft eine tote Verbindung (Entscheid 177).
- Spaeter `WireGuardTransport`: userspace TCP/IP + WireGuard im WASM, UDP-Pakete ueber
  Wisp-UDP. WebCore und curl merken davon nichts.

### Service Worker und Speicher der Seiten
Was in WebKit2 im Network-Prozess laeuft, sitzt im Engine-Thread, verbunden ohne IPC:

- Service Worker und SharedWorker (`engine/src/ServiceWorkerWasm.cpp`, Entscheid 103): SWServer,
  Client- und Context-Verbindung im selben Thread. Der Fetch-Abfang sitzt in der LoaderStrategy.
  Hintergrund-Aktualisierung laedt der Server selber (`SWServerDelegate::softUpdate`, Patch 0033
  erkennt seine eigenen Jobs). Navigation Preload, Benachrichtigungen aus dem Worker und
  `clients.openWindow()` (nur nach `notificationclick`, nur http(s)) siehe Entscheid 154.
  `WindowClient.navigate()` endet mit dem Laden des Frames: TypeError bei einem Fehler vor dem
  Commit, sonst der neue Client oder null.
- Cache API (`engine/src/CacheStorageWasm.cpp`): pro Ursprung eine Datei mit den Eintraegen
  unter `/data/cachestorage`, jeder Inhalt als eigene Datei, gelesen erst bei `match`
  (Entscheid 155), hoechstens 256 MB pro Ursprung.
- Origin Private File System (`engine/src/FileSystemStorageWasm.cpp`, Entscheid 95): Dateien
  unter `/data/opfs/<Ursprung>/`, `createWritable` in einer Kopie unter `/data/opfs-swap`.
  `close()` und `move()` einer Datei nur mit `rename`, Ordner als Kopie (Entscheid 166).

### Threads
Emscripten pthreads, braucht `SharedArrayBuffer`. Dafuer muss die Seite mit diesen Headern
ausgeliefert werden:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Speicher
Cookies (SQLite), localStorage, IndexedDB, Cache API, Service Worker und OPFS der Seiten liegen
in der Engine unter `/data`. Die Engine benutzt WasmFS (`-sWASMFS`): das Dateisystem lebt im
WASM, Datei-Syscalls aus jedem Thread gehen direkt, ohne Umweg ueber den UI-Thread. `/data` ist
ein Verzeichnis im Origin Private File System (OPFS) des Host-Browsers (`engine/src/Storage.cpp`,
WasmFS-Backend fuer OPFS, das ueber einen eigenen Worker mit synchronen Zugriffs-Handles
arbeitet). Bleibt also zwischen Besuchen erhalten. Ohne OPFS (node-Tests) ist `/data` nur im
Speicher.

- Nur ein Tab des Host besitzt `/data` (`navigator.locks` `bl-data`). Ein zweiter laeuft mit
  `/data` im Speicher und zeigt einen Hinweis.
- Ganze Dateien ersetzt `replaceWholeFile` atomar: Kopie in `/data/tmp`, dann `rename`.
  `/data/tmp` wird beim Start geleert. Ein Lesefehler gilt nie als "Datei fehlt", sonst
  wuerde eine leere Datei eine gute ueberschreiben.
- Uploads, Drag & Drop und Einfuegen schreibt die Engine nach `/data/tmp/uploads/<Tab>/`
  (OPFS), der Engine-Thread liest sie selber in Stuecken (Entscheid 181). Der Ordner geht mit
  dem Tab (`bl_remove_path`).
- IndexedDB hoechstens 256 MB pro Ursprung, begrenzt ist nur das Schreiben (Patch 0040,
  Entscheid 179).

SQLite schreibt jede WAL-Seite einzeln (mit seek davor): beim Laden von CNN waren das ca.
7000 Zugriffe nur fuer die Cookie-Datenbank. Darum gibt es ein eigenes SQLite-VFS
(`engine/src/MemoryVFS.cpp`): Datenbank, `-journal`, `-wal` und der gemeinsame Speicher fuer
den WAL-Index liegen im WASM-Speicher (in Bloecken von 64 KB, Locks nur im Prozess). Auf die
Platte kommt nur die Datenbank mit den bestaetigten Seiten aus dem WAL, als eine Datei, wenn
gerade keine Schreib-Transaktion laeuft: kurz nach jeder Aenderung (im Engine-Thread), beim
Schliessen des Tabs mit Warten (`bl_storage_flush`) und wenn die letzte Verbindung zu einer
Datenbank schliesst (Entscheid 180). Danach liest das
VFS wieder von der Platte, damit es stimmt, wenn WebKit Dateien selber loescht
(`indexedDB.deleteDatabase`). `-journal` und `-wal` liegen nur im Speicher, nie auf der
Platte.

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
- `MediaFetch` laedt http(s) mit curl (gleiche Helfer wie der Loader), `blob:` und `data:`
  aus dem Speicher (`BlobResourceHandle`, mit Range). Ein `blob:` bleibt auch nach
  `revokeObjectURL` abspielbar.
- Bilder: jedes Bild bekommt einen eigenen Puffer, den die Engine uebernimmt; das naechste
  schickt die Oberflaeche erst nach der Antwort `frame`. Das neuste Bild ist ein
  unveraenderliches `NativeImage` ueber diesem Puffer, freigegeben erst, wenn auch die
  Aufzeichnungen der Kachel-Maler es loslassen. `canvas.drawImage(video)` braucht keine Kopie.
- `preload` (`none`, `metadata`, `auto`) und spaetere Aenderungen gehen an das Host-`<video>`.
- Zustand (Zeit, Dauer, readyState, buffered) meldet die Oberflaeche bei jedem Event des
  Host-`<video>`, dazwischen rechnet die Engine die Zeit selber weiter.
- MSE: WebCore bekommt Spuren und Zeitstempel aus `ContainerParser` (fMP4, WebM) und macht
  daraus `buffered`, Springen und Speicherverwaltung. Die gleichen Bytes gehen an ein
  MediaSource im Host, das dekodiert. `readyState` ist das Minimum von beiden.
- Der Ton kommt direkt aus dem Host-`<video>`. Chrome erlaubt Ton erst nach einem Klick, stumme
  Videos duerfen sofort laufen (wie in einem normalen Browser).

### Hosting
Ein Container (`Dockerfile`, `relay/server.mjs`): liefert die Seite mit den Headern oben
und vorkomprimiert (Brotli, mit ETag/304) aus und ist das Wisp-Relay. HTTPS kommt von einem
Proxy davor (Browser geben SharedArrayBuffer nur in einem sicheren Kontext). Das Relay
verbindet nur zu oeffentlichen Unicast-Adressen und erlaubten Ports; jede Adresse prueft sein
Socket direkt vor dem Verbinden (`relay/wisp.mjs`, Entscheide 159, 175). Auf einem
oeffentlichen Server braucht es `RELAY_TOKEN` (sonst nutzen fremde Leute ihn als Proxy),
intern geht es ohne. Ablauf in [deploy/README.md](../deploy/README.md).
