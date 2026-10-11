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
  linken ohne brotlicommon. ICU-Daten sind noch voll (33 MB), Filter kommt in Phase 8.
- Skia ist nicht dabei: es ist in WebKit enthalten (`Source/ThirdParty/skia`) und wird mit WebKit gebaut.
- Fonts (Noto) kommen in Phase 4, wenn wir sie zum ersten Mal brauchen.

## Phase 2: JavaScriptCore im Browser  (in Arbeit)
- [x] JSC (PORT=JSCOnly, CLoop, kein JIT) baut und linkt mit Emscripten (`tools/build-jsc.sh`)
- [x] `jsc`-Shell laeuft in node (`tests/jsc/run.sh`)
- [x] **GC-Problem bestaetigt und geloest:** Ohne Massnahme stuerzt der GC-Stresstest
  (`--slowPathAllocsBetweenGCs=10`) in 5 von 5 Laeufen ab (in `materializePropertyTable`, genau
  wie der offene Discord-Absturz im Referenzprojekt). Mit `--spill-pointers` laufen 5 von 5 durch.
- [x] Patches 0001-0004 (OS(EMSCRIPTEN), wasm32-Fixes, kein Thread::suspend, LLInt-Extractors, Debug-Flags)
- [x] CI-Job `jsc` mit ccache und Tests
- [ ] Groesse/Speed von `--spill-pointers` messen und optimieren
- [ ] jsc im Browser (headless Chromium) statt nur node

## Phase 3: WTF + WebCore bauen (`PORT=Wasm`)
`OptionsWasm.cmake` + `PlatformWasm.cmake`. Viele Features erstmal aus (Media, WebRTC,
WebGL, WebXR, Accessibility, ...). Ziel: alles linkt.

## Phase 4: Embedding + erstes Bild
Eigene WebCore-Clients, HTML aus String laden, mit Skia malen, aufs Canvas bringen.
Test: Screenshot-Vergleich.

## Phase 5: Netzwerk ueber Wisp
Socket-Schicht + Transport-Interface + Wisp-Client. HTTP/1.1, HTTP/2, TLS, Cookies,
Redirects, Kompression, WebSockets. Relay auf dem VPS mit Auth.

## Phase 6: Browser-UI und Input
Tabs, Adressleiste, Zurueck/Vor/Reload, Maus, Scrollen, Tastatur (inkl. Schweizer Layout),
Copy/Paste, Dialoge, Upload/Download, HiDPI.

## Phase 7: Persistenz
WasmFS + OPFS: Cookies, localStorage, IndexedDB, Cache. "Daten loeschen"-Knopf.

## Phase 8: Performance + Kompatibilitaet
GPU-Rendering (Skia auf WebGL2), Threads fuer Bilder/Parsing, LTO/SIMD, Service-Worker-Cache
fuer das .wasm, CLoop-Tuning. Kompatibilitaetsliste Top-50 Seiten in CI.

## Phase 9: Media (spaeter)
`<audio>`/`<video>` ueber WebCodecs + Web Audio, danach MSE.

## Zukunft: WireGuard
`WireGuardTransport` (userspace TCP/IP + WireGuard im WASM, UDP ueber Wisp).
