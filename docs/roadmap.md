# Roadmap

Jede Phase endet mit etwas das in CI getestet wird. Die grossen Risiken (Build in CI, GC)
kommen zuerst.

## Phase 0: Grundlagen  (fertig)
- [x] Repo-Struktur, Lizenz, Doku
- [x] Versions-Pins in `versions.env` (WebKit `wpewebkit-2.54.1`, Emscripten 6.0.10)
- [x] WebKit holen (shallow, sparse, blobless) + Patch-Workflow
- [x] Toolchain-Docker-Image
- [x] CI: Lint, Toolchain-Image bauen + testen, WebKit holen + Patches pruefen
- [x] Referenzprojekt WebkitWasm analysiert ([Notizen](referenz-webkitwasm.md))

## Phase 1: Dependencies nach WASM  (fertig)
- [x] 19 Libs gepinnt mit SHA256/Commit in `deps/sources.txt`, ein Rezept pro Lib in `deps/recipes/`
- [x] `deps/build-all.sh` mit Stamps (baut nur neu was sich geaendert hat)
- [x] Smoke-Test `deps/test.sh`: alle Libs in ein Programm gelinkt, laeuft in node
- [x] CI-Job `deps` (mit Cache)
- Erkenntnisse: ICU baut im Cross-Build nur Stub-Daten, wir machen `libicudata.a` selber aus dem
  Host-Archiv (`genccode -e icudt78`). fontconfig braucht Meson >= 1.6 (aus pip). Die woff2-Tools
  linken ohne brotlicommon. ICU-Daten werden seit Phase 8 gefiltert (siehe dort).
- Skia ist nicht dabei: es ist in WebKit enthalten (`Source/ThirdParty/skia`) und wird mit WebKit gebaut.
- Fonts (Noto) kommen in Phase 4, wenn wir sie zum ersten Mal brauchen.

## Phase 2: JavaScriptCore im Browser  (fertig)
- [x] JSC (PORT=JSCOnly, CLoop, kein JIT) baut und linkt mit Emscripten (`tools/build-jsc.sh`)
- [x] `jsc`-Shell laeuft in node (`tests/jsc/run.sh`)
- [x] **GC-Problem bestaetigt und geloest:** Ohne Massnahme stuerzt der GC-Stresstest
  (`--slowPathAllocsBetweenGCs=10`) in 5 von 5 Laeufen ab (in `materializePropertyTable`, genau
  wie der offene Discord-Absturz im Referenzprojekt). Mit `--spill-pointers` laufen 5 von 5 durch.
- [x] Patches 0001-0004 (OS(EMSCRIPTEN), wasm32-Fixes, kein Thread::suspend, LLInt-Extractors, Debug-Flags)
- [x] CI-Job `jsc` mit ccache und Tests
- [ ] Groesse/Speed von `--spill-pointers` messen und optimieren

## Phase 3: WTF + WebCore bauen (`PORT=Wasm`)  (fertig)
- [x] `OptionsWasm.cmake` + `PlatformWasm.cmake` (Patch 0006), Plattform-Code in `platform/wasm/` (0008)
- [x] Media, WebRTC, WebGL, WebXR, Accessibility usw. aus
- [x] Kleine Fixes fuer wasm32 (Persistenz-Coder fuer `unsigned long`, 0009) und OpenSSL 3 (0010)
- Erkenntnisse: `GraphicsLayer::create` wird auch ohne Compositing gelinkt, darum eine leere
  `GraphicsLayerWasm`. Einige Deps sind C++ und koennen werfen, darum `-sDISABLE_EXCEPTION_THROWING=0`
  beim Link (WebKit selber baut mit `-fno-exceptions`).

## Phase 4: Embedding + erstes Bild  (fertig)
- [x] Eigene Clients (Chrome, FrameLoader, Editor, ProgressTracker, BackForwardList) in `engine/`
- [x] Skia-Raster in einen Pixel-Buffer, Host malt per `putImageData`
- [x] Render-Test in node (`tests/engine/render-test.mjs` + `check-basic.mjs`): Kasten, Kreis, Text, JS

## Phase 5: Netzwerk ueber Wisp  (fertig, lokal getestet)
- [x] curl-Backend von WebCore ueber eigene LoaderStrategy, Sockets ueber Emscripten SOCKFS
  -> `TransportSocket` -> Wisp-Stream (`web/transport.js`)
- [x] Relay (`relay/`) mit Token, ohne private Netze, nur Web-Ports; Caddy + docker-compose
- [x] e2e in Chromium (`tests/e2e/network-test.mjs`): Redirect, Cookie, Skript, fetch mit gzip
- [x] Echte HTTPS-Seiten (`tests/e2e/site-test.mjs`): example.com, Wikipedia, SRF, Google,
  Hacker News und GitHub laden und werden richtig gemalt
- [x] Zusaetzliche CA moeglich (`extra-ca.crt`, z.B. Firmen-CA)
- [x] WebSockets der Gastseiten (ws:// und wss://), getestet mit Echo-Servern
- [x] TLS-Test ohne Internet: lokaler HTTPS/WSS-Server mit eigener Test-CA in `network-test.mjs`
- [x] CI-Jobs `engine` und `e2e` gruen

## Phase 6: Browser-UI und Input  (fertig)
- [x] Tabs, Adressleiste, Zurueck/Vor/Reload, Ladebalken, Dialoge (alert/confirm/prompt)
- [x] Maus, Mausrad, Tastatur; Texteingabe ueber verstecktes Textfeld: tote Tasten
  (Schweizer Tastatur), IME und Bildschirmtastatur kommen als fertiger Text
- [x] Copy/Paste mit der echten Zwischenablage
- [x] Popups (`target=_blank`, `window.open`) werden neue Tabs, `window.close` schliesst sie
- [x] Downloads (Content-Disposition, `<a download>`, unbekannte Typen) als Blob
- [x] Datei-Upload (`<input type=file>`, FileReader, Formulare/fetch)
- [x] HiDPI (devicePixelRatio)
- [x] e2e-Test `tests/e2e/input-test.mjs`
- [x] Kontextmenue (Rechtsklick): Link/Bild in neuem Tab, Adresse kopieren, Kopieren/Einfuegen,
  Zurueck/Vor/Neu laden. Seiten mit eigenem Menue bekommen das contextmenu-Event wie gewohnt
- [x] Favicons: die Engine sucht das Icon (`<link rel=icon>`, sonst `/favicon.ico`) und laedt
  es selber, die Oberflaeche zeigt es im Tab
- [x] Vollbild (`requestFullscreen`): der Seitenbereich wird im Host-Browser gross, Esc beendet
  es auch fuer die Seite
- [x] `<select>`-Listen (vorher gingen sie gar nicht auf): eigene Liste in der Oberflaeche mit
  Maus, Pfeiltasten, Tippen zum Springen, Esc (`engine/src/Choosers.cpp`, `web/pickers.js`)
- [x] Farb- und Datumsauswahl (`<input type=color/date/time/datetime-local/month/week>`) ueber
  den echten Dialog des Host-Browsers (verstecktes Feld + `showPicker`)
- [x] Link-Adresse unten links beim Darueberfahren, Tooltips (`title`)
- [x] Suchen auf der Seite (Strg+F, F3, Enter/Umschalt+Enter, "x von y"), Zoom (Strg +/-/0,
  Strg+Mausrad, Anzeige in der Leiste), Tastenkuerzel wie Chrome (Strg+L/T/W/R/Tab/1-9,
  Alt+Links/Rechts, F5, F6), Tab aus der Adressleiste in die Seite und zurueck
- [x] Markieren mit der Maus (ging nicht: steckt in WebCore hinter `ENABLE_DRAG_SUPPORT`)
- [x] Touch (Chromebooks): echte Touch-Events an die Seite, Wischen scrollt mit Schwung,
  Antippen = Klick, langes Druecken = Kontextmenue. `ontouchstart` nur mit Touchscreen
- [x] Abfragen wie Chrome ("... moechte deinen Standort verwenden"), Entscheidung pro Seite:
  Standort und Benachrichtigungen ueber den Host-Browser, `navigator.permissions` passt dazu
- [x] Gamepads (mit Vibration), Pointer Lock (`movementX/Y`), Sprachausgabe (`speechSynthesis`
  des Hosts), Dunkelmodus des Systems (`prefers-color-scheme`)
- [x] Sitzung wiederherstellen (Hintergrund-Tabs laden erst beim Anklicken), Verlauf (Strg+H),
  Lesezeichen (Stern, Strg+D, Strg+Umschalt+O), Download-Liste (Strg+J), Einstellungen
  (Suchmaschine, Startseite), Vorschlaege in der Adressleiste. Test `tests/e2e/ui-test.mjs`

## Phase 7: Persistenz  (fertig)
- [x] Cookies in SQLite, localStorage und IndexedDB (aus `WebKitLegacy/Storage`) unter `/data`
- [x] `/data` ist ein IDBFS: wird beim Start aus der IndexedDB des Host-Browsers geladen und
  alle 5 s sowie beim Verlassen gespeichert
- [x] Knopf "Gespeicherte Daten loeschen"
- [x] e2e-Test `tests/e2e/storage-test.mjs`
- Erkenntnis: OPFS waere schneller, braucht aber WasmFS, und WasmFS kann (noch) keine Sockets.

## Phase 8: Performance + Kompatibilitaet  (angefangen)
- [x] Auslieferung: Engine in `engine/<version>/`, Funktionsnamen raus, vorkomprimiert
  (`tools/optimize-site.mjs`, engine.wasm 120 MB -> 21 MB brotli)
- [x] ICU-Datenfilter (33 MB -> 19 MB): nur noetige Konverter, Anzeigenamen nur fuer ca. 50 Sprachen
- [x] Startzeit gemessen: Engine bereit nach ca. 2 s (lokal)
- [x] `--spill-pointers` ersetzt durch GC auf leerem Stack (siehe Architektur): erste Seite
  14x schneller aufgebaut, engine.wasm 126 MB -> 92 MB. Echte Seiten jetzt 2-5x schneller
  (Wikipedia 40 s -> 12 s, GitHub 19 s -> 8 s)
- [x] fontconfig-Cache im Datenpaket (`deps/tools/fc-precache.c`)
- [x] Debug-Ausgabe der Engine mit `?debug=1` (Zeitstempel, lange Schritte, GC)
- [x] Scrollen verschiebt Pixel statt alles neu zu malen (nur der neue Streifen wird gemalt)
- [x] Leerlauf: der GC-Timer von JSC feuerte wegen DeferGC pausenlos (100 % CPU im Engine-Worker),
  jetzt wartet die GC-Anforderung bis zum Ende der Aufgabe (Patch 0012)
- Gemessen: der erste Durchlauf (DOM, Parser, Layout) ist ca. 4x langsamer als spaetere. Das ist
  vor allem einmalige Initialisierung (Schriften, CSS), nicht die WASM-Optimierung von Chrome
  (mit `--no-wasm-dynamic-tiering` gleich langsam). Aufwaermen wuerde die Kosten nur verschieben.
- [x] WebGL 1 und 2: die GL-Aufrufe gehen ueber einen kleinen ANGLE-Ersatz an ein WebGL im
  Engine-Worker (kein ANGLE im WASM). Bild per `readPixels` in die Seite. Beliebig viele
  Kontexte (ein geteilter Host-Kontext pro Version). three.js-Beispiele laufen.
  Test: `tests/e2e/webgl-test.mjs`
- [x] `toDataURL`/`toBlob` (PNG, JPEG, WebP): Skia-Encoder eingeschaltet, vorher immer `data:,`
- [x] WebAssembly der Seiten: Module laufen in der WASM-Engine des Browsers, Speicher als
  Bereich im Engine-Speicher (Modul wird umgeschrieben), API in JSC nachgebaut. Auch in
  Workern. Tests: `tests/wasm/` (node) und `tests/e2e/wasm-test.mjs` (u.a. ein
  Emscripten-Programm). sql.js laeuft, die Cloudflare-Pruefung kommt jetzt bis zum Klick.
- [x] Speicher-Spitzen: GC auch mitten in langen Skripten (an sicheren Punkten im Interpreter)
  und automatisches Freigeben der WebKit-Caches, wenn malloc ueber 192 MB waechst (siehe
  Architektur). Bericht in der
  Konsole mit `__blMemory(true)`
- [x] JS-Aufrufe: die Aufruf-Caches des Interpreters waren auf 32 Bit abgeschaltet, jeder
  Aufruf ging durch C++. Eingeschaltet (Patch 0019): Aufrufe, Klassen und Callbacks 30-40 %
  schneller
- [x] Skia malt mit SIMD (SSE4.1-Pfad ueber WASM-SIMD, Patch 0020): Malen ca. 2x schneller
- [x] TLS: ChaCha20 statt AES-GCM (keine AES-Hardware in WASM), Krypto auf dem curl-Thread
  4x schneller (Patch 0021)
- [x] WebCrypto: AES-GCM, RSA-OAEP und RSA-PSS gingen mit OpenSSL 3 nicht (Patch 0010).
  Damit kommen SBB, IMDb und Booking durch die Bot-Pruefung von AWS WAF.
  Test `tests/engine/crypto.html` in CI
- [x] Dauerhafter HTTP-Cache (Cache API des Host): beim zweiten Besuch kommt fast alles aus dem
  Cache oder wird nur mit 304 nachgeprueft. Test `tests/e2e/cache-test.mjs`
- [x] WebCrypto: Ed25519 und X25519 ueber OpenSSL (WebKit hatte dafuer nur Code fuer Apple und
  libgcrypt). Erzeugen, Signieren/Pruefen, deriveBits, Import/Export raw/jwk/spki/pkcs8, getestet
  mit den Testvektoren aus RFC 8032 und RFC 7748
- [x] SQLite-Datenbanken (Cookies, localStorage, IndexedDB) im WASM-Speicher statt ueber das
  JS-Dateisystem auf dem UI-Thread (eigenes VFS): Dateizugriffe auf CNN 12 600 -> 3 200
- [x] Eigene Socket-Schicht im WASM statt SOCKFS (`engine/src/Sockets.cpp`): kein synchroner
  Umweg ueber den UI-Thread mehr fuer send/recv/poll, Grundlage fuer WireGuard. Dateizugriffe
  ueber den UI-Thread beim Laden von CNN jetzt ca. 2 000 (vorher 12 600)
- [x] Haenger (nzz.ch, 20min.ch, ab und zu): Selbst-Deadlock auf dem Haupt-Thread gefunden
  (Stack ueber das Debugger-Protokoll, jetzt im Kompatibilitaets-Test) und behoben
- [x] Absturz auf x.com: WebKit-Fehler im C-Loop, nach einem VM-Trap stimmte die Stack-Grenze
  nicht mehr und tiefe Rekursion ueberschrieb fremden Speicher (Patch 0022, Test
  `tests/engine/stack.html`). Gefunden ueber das Kernel-Log (Segfault im Worker), `gdb` und die
  perf-Map von V8 (`--perf-basic-prof`). Dabei auch: der GC waehrend langer Skripte kam auf
  echten Seiten fast nie dran, jetzt auch beim Funktionseintritt
- [x] Messlatte gegen Chromium (`tests/engine/features.html`, `tests/e2e/parity-test.mjs`):
  277 Pruefungen (JS, WebAssembly, DOM, Grafik, CSS, Netz, Medien, Geraete). Stand:
  206 von 277 wie Chromium (74 %). In CI als Bericht, rot nur bei Rueckschritt
- [x] Viele fertige WebKit-Funktionen waren nur per Einstellung aus (Standard fuer WebCore allein):
  Navigation API, Compression Streams, Permissions, Lazy Loading, Visual Viewport, Beacon,
  `<datalist>`, Async Clipboard, Datum/Farbe, Formular-Pruefung mit Hinweis, Quirks u.a.
- [x] Resizable ArrayBuffer (ES2024) stuerzte ab: bmalloc/WTF brauchten echtes mmap (Patch 0023)
- [x] JSC lief ohne JIT im Mini-Modus (nur volle GCs, kaum Heap-Wachstum): weather.com verbrachte 35 s
  in der GC und lief ins Zeitlimit. Mini-Modus aus (Patch 0028), Bytecode wird weiter verworfen:
  GC 6 s, Seite laedt (#122)
- [x] WebGL-Host-Kontexte schon beim Start anlegen: das erste Anlegen wartete mitten im Laden auf die
  ausgelastete GPU (weather.com 15 s, #123). Dauerhafter Bytecode-Cache gemessen und verworfen (#124)
- [x] Drag & Drop: HTML5-Ziehen in der Seite (war ohne DragClient tot), Dateien und Text aus dem System
  ablegen, auch auf `<input type=file>` (#125, `dragdrop-test.mjs`)
- [x] Zwischenablage mit HTML und Bildern (Einfuegen und Kopieren), `getData('text/plain')` im paste-Ereignis,
  Doppel-/Dreifachklick (Klickzahl war immer 1) (#126, `clipboard-test.mjs`)
- [x] IME-Vorschau (composition-Ereignisse, unterstrichener Text) und Kandidatenfenster beim Cursor (#127)
- [x] Hintergrund-Tabs bei wenig Speicher verwerfen, Neuladen beim Anklicken (#128, Test im `ui-test.mjs`)
- [x] Zurueck/Vor ging nie (keine Verlaufseintraege, leerer Client), jetzt mit Back/Forward-Cache und Verlauf
  pro Tab in der Sitzung und nach dem Verwerfen (#129)
- [x] Passwort-Speicher wie Chrome: "Passwort speichern?" nach dem Anmelden, Ausfuellen beim Fokus,
  "aktualisieren?" bei neuem Passwort, Liste im Menue, verschluesselt im Host (#130, `passwords-test.mjs`)
- [x] PDFs im Tab wie Chrome (Viewer des Host-Browsers, richtiger Dateiname, Zurueck, Drucken); ohne
  Viewer Download. Offen: PDFs in iframes (bleiben leer) (#131, `pdf-test.mjs`)
- [x] Touchpad-Pinch: Ereignisse summieren, eine Zoom-Stufe pro 40 px (vorher eine Stufe pro Ereignis).
  Offen: echtes Pinch-Zoom wie Chrome (nur die Ansicht skalieren, im Compositor-Thread, "delegated scaling")
- [x] Warten auf den UI-Thread beim Laden (CPU-Profil des Engine-Workers + Chrome-Trace): die
  Engine malt jetzt selber in das Canvas des Tabs (`transferControlToOffscreen`), der UI-Thread
  kopiert keine Bilder mehr und blockiert nicht beim Compositor-Commit. Dazu Antworten merken
  (Schriftpruefung in Skia, `canPlayType`, `access()`) und eine gemeinsame Crypto-Queue statt
  einem Thread pro iframe (Patch 0024). CNN: Engine wartet 0.5 statt 4.5 s, Ladezeit
  19.8 -> 16.2 s (Mittel aus 3 Laeufen). mimalloc statt dlmalloc getestet: langsamer
- [x] GPU-Rastern: Skia malt ueber WebGL 2 (Ganesh, wie CanvasKit) im Engine-Worker, Scrollen
  kopiert auf der GPU, Bild ohne Kopie per `transferToImageBitmap` ins Tab-Canvas. Faellt bei
  Kontextverlust auf die CPU zurueck (Test in `network-test.mjs`). Offen: CSS-Filter (`filter:
  blur()`) laufen noch ueber WebCores Software-Filter, dafuer braucht WebCore den GPU-Kontext
  ueber `PlatformDisplay`; danach Ebenen (Compositing)
- [x] GitHub-Startseite blieb ca. 10 s weiss: der Engine-Worker kam bei Dauer-Animationen nicht in
  den JS-Event-Loop zurueck, das OffscreenCanvas zeigte darum kein neues Bild. Eigene Liste fuer
  die Aufgaben der Engine (`EngineLoop.cpp`). Zur Fehlersuche: `__blEval("js")` in der Konsole
  fuehrt JS in der Seite aus (auch bei strenger CSP) und zeigt, ob WebKit das Malen sperrt
- [x] Messlatte 228 von 277 (82 %): Canvas-Filter, `moveBefore`, `select.showPicker`,
  `scrollbar-color`, `navigator.storage`, `screen.orientation`, Wake Lock, `scheduler.postTask`,
  `navigator.vibrate`. Funktions-Pruefungen in `devices-test.mjs`
- [x] Oberflaeche: Strg/Cmd+Klick und Mittelklick oeffnen Links im Hintergrund-Tab, Quelltext
  anzeigen (Strg+U, Kontextmenue), Sicherheitsanzeige (Schloss bei HTTPS, "Nicht sicher" bei
  HTTP). Tests in `ui-test.mjs`
- [x] Cache API (`caches.*`) im Speicher der Engine (pro Sitzung). Messlatte 230 von 277 (83 %)
- [x] Compositing mit Ebenen (Coordinated Graphics, Skia-Compositor), Standard
  an mit WebGL 2 (`?compositing=0` schaltet ab). Test `compositing-test.mjs`: Farben, Animation
  ohne Neumalen, Opacity, Blur auf der GPU, WebGL als Ebene, fixierte Leiste beim Scrollen.
  Scrollen: NZZ/Wikipedia ohne langsame Bilder, GitHub 1946 -> 701 ms; Laden 5-15 % schneller.
- [x] Compositor-Thread mit eigenem WebGL-Kontext: Animationen laufen weiter, auch wenn das JS der
  Seite den Engine-Thread blockiert (`compositing-test.mjs`)
- [x] Asynchrones Scrollen: WebKits ScrollingTree (ENABLE_ASYNC_SCROLLING) auf einem eigenen Thread,
  Rad- und Wisch-Events ueber den Compositor-Thread direkt dorthin. Scrollen geht auch, waehrend das
  JS der Seite blockiert (`compositing-test.mjs`)
- [x] Origin Private File System (`navigator.storage.getDirectory`, Writable Streams, synchroner
  Zugriff im Worker) und `requestVideoFrameCallback`. Messlatte 233 von 277 (84 %)
- [x] Lage-/Bewegungssensoren (`deviceorientation`, `devicemotion`) vom Host (`devices-test.mjs`).
  Messlatte 234 von 277 (84.5 %)
- [x] Service Worker (SWServer im selben Prozess, Fetch abfangen) und SharedWorker
  (`serviceworker-test.mjs`). Registrierungen und Cache API bleiben nach einem Neustart.
  Offen: Skript im Hintergrund aktualisieren, Navigation Preload, Push
- [ ] WebAssembly: geteilter Speicher (Threads), memory64, mehrere Speicher, JSPI
- [ ] Timer-Queries (`EXT_disjoint_timer_query`): in WebKit hinter einer Einstellung, aus
- [ ] Laufende Queries/Transform Feedback ueber einen Kontext-Wechsel hinweg (selten)
- [ ] WebGL ohne `readPixels`: Bild direkt als ImageBitmap zum Host (braucht Compositing)
- [ ] Service-Worker-Cache (vorerst reicht der HTTP-Cache: Engine-Dateien sind versioniert und immutable)

- [x] Kompatibilitaetsliste: 52 Seiten in `tests/e2e/sites.txt`, eigener CI-Job, Stand in
  `docs/kompatibilitaet.md`. Alle erreichbaren Seiten laden ohne Absturz.
- [x] Cloudflare-Pruefung (Turnstile): mit WebAssembly kommt sie bis zum Kaestchen "Verify you
  are human" (vorher blieb sie bei "Verifying" haengen)

Offen: GPU-Rendering (Skia auf WebGL2), Threads fuer Bilder/Parsing, LTO/SIMD,
Service-Worker-Cache fuer das .wasm, CLoop-Tuning.

## Phase 9: Media (spaeter)
- [x] `ENABLE_VIDEO` an, ohne Abspiel-Backend: `<video>`/`<audio>` sind echte Media-Elemente,
  `play()` lehnt mit NotSupportedError ab. Vorher stuerzten Seiten wie 20min.ch ab.
- [x] Web Audio mit echtem Ton: Engine rendert in einen Ringpuffer, ein AudioWorklet im
  Host-Browser spielt ab. `decodeAudioData` ueber den Dekoder des Host-Browsers, eigene FFT,
  HRTF-Daten. Test: `tests/e2e/audio-test.mjs`
- [x] `<audio>`/`<video>` abspielen (Dateien): verstecktes `<video>` im Host-Browser spielt ab,
  die Daten holt ein Service Worker (`web/sw.js`) in Stuecken von 2 MB bei der Engine (Range ueber
  das Relay), die Bilder kopiert die Oberflaeche in den WASM-Speicher, die Engine malt sie.
  Test: `tests/e2e/media-test.mjs`
- [x] MSE (YouTube & Co.): WebCore macht die MSE-Logik mit Zeitstempeln aus eigenen kleinen
  Parsern fuer fMP4 und WebM (`engine/src/media/ContainerParser.cpp`), die Daten gehen
  zusaetzlich an ein MediaSource im Host-Browser, das abspielt. Test in `media-test.mjs`
- [x] `SourceBuffer.remove()` und das Aufraeumen von WebCore gehen auch an das MediaSource im Host
  (Hook `didRemoveCodedFrames`, Patch 0017)
- [x] WebCodecs fuer Seiten und Worker: Video/Audio dekodieren und kodieren ueber die Codecs des
  Host-Browsers, `VideoFrame` aus Canvas, Bild, Video und Rohdaten (I420, NV12, RGBA, ...),
  `AudioData` in allen Formaten. Test: `tests/e2e/webcodecs-test.mjs`. Offen: `ImageDecoder`
  (hat WebKit nicht), Bilder direkt als Textur statt ueber den Speicher
- [x] Spracherkennung (`webkitSpeechRecognition`) ueber den Host-Browser, mit Mikrofon-Abfrage
  (Test in `devices-test.mjs`)
- [x] Drucken: PDF aus der Engine (Skia PDF, `@media print`, Seitenumbrueche), Druckvorschau mit
  Druckdialog des Host und "Als PDF speichern" (Test in `ui-test.mjs`)
- [x] File System Access (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`) ueber die
  Dialoge und Handles des Host-Browsers (Test in `devices-test.mjs`)
- [x] Lautsprecher im Tab und Tab stummschalten (Test in `audio-test.mjs`)
- [x] Kamera, Mikrofon und Bildschirm (`getUserMedia`, `getDisplayMedia`, `enumerateDevices`) ueber die
  Geraete des Host, `<video>.srcObject` (Bild und Ton), Mikrofon in Web Audio (Test `mediastream-test.mjs`).
  Offen: WebRTC-Medien
- [x] WebRTC Stufe 1: `RTCPeerConnection` + `RTCDataChannel` ueber das WebRTC des Host (Test `webrtc-test.mjs`,
  auch gegen eine normale Chromium-Seite)
- [x] WebRTC Stufe 2: Medien senden und empfangen (Kamera, Mikrofon, Canvas, Web Audio), Transceiver-API.
  Offen: Verkehr ueber das Relay (TURN), Insertable Streams
- [x] Picture-in-Picture ueber das versteckte Host-`<video>` (Test im `media-test.mjs`), auch fuer `srcObject`-Streams (Kamera, WebRTC, Canvas; Test im `mediastream-test.mjs`)
- [x] MediaRecorder: WebM (VP8/VP9/AV1 + Opus) mit den Encodern des Host, Web Audio als Stream-Quelle
  (`createMediaStreamDestination`), Test in `mediastream-test.mjs` (Chromium spielt die Aufnahme ab)

## Zukunft: WireGuard
`WireGuardTransport` (userspace TCP/IP + WireGuard im WASM, UDP ueber Wisp).
