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
- [ ] WebSockets der Gastseiten testen
- [ ] CI-Jobs `engine` und `e2e` gruen (Build dauert in CI lange, ccache ueber mehrere Laeufe)

## Phase 6: Browser-UI und Input
Tabs, Adressleiste, Zurueck/Vor/Reload, Maus, Scrollen, Tastatur (inkl. Schweizer Layout),
Copy/Paste, Dialoge, Upload/Download, HiDPI.

## Phase 7: Persistenz
WasmFS + OPFS: Cookies, localStorage, IndexedDB, Cache. "Daten loeschen"-Knopf.

## Phase 8: Performance + Kompatibilitaet  (angefangen)
- [x] Auslieferung: Engine in `engine/<version>/`, Funktionsnamen raus, vorkomprimiert
  (`tools/optimize-site.mjs`, engine.wasm 120 MB -> 21 MB brotli)
- [x] ICU-Datenfilter (33 MB -> 19 MB): nur noetige Konverter, Anzeigenamen nur fuer ca. 50 Sprachen
- [ ] Startzeit messen, Service-Worker-Cache

GPU-Rendering (Skia auf WebGL2), Threads fuer Bilder/Parsing, LTO/SIMD, Service-Worker-Cache
fuer das .wasm, CLoop-Tuning. Kompatibilitaetsliste Top-50 Seiten in CI.

## Phase 9: Media (spaeter)
`<audio>`/`<video>` ueber WebCodecs + Web Audio, danach MSE.

## Zukunft: WireGuard
`WireGuardTransport` (userspace TCP/IP + WireGuard im WASM, UDP ueber Wisp).
