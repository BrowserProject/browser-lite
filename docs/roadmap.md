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
`<audio>`/`<video>` ueber WebCodecs + Web Audio, danach MSE.

## Zukunft: WireGuard
`WireGuardTransport` (userspace TCP/IP + WireGuard im WASM, UDP ueber Wisp).
