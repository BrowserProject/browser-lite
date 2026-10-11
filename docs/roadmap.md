# Roadmap

Jede Phase endet mit etwas das in CI getestet wird. Die grossen Risiken (Build in CI, GC)
kommen zuerst.

## Phase 0: Grundlagen  (in Arbeit)
- [x] Repo-Struktur, Lizenz, Doku
- [x] Versions-Pins in `versions.env` (WebKit `wpewebkit-2.54.1`, Emscripten 6.0.10)
- [x] WebKit holen (shallow, sparse, blobless) + Patch-Workflow
- [x] Toolchain-Docker-Image
- [x] CI: Lint, Toolchain-Image bauen + testen, WebKit holen + Patches pruefen
- [x] Referenzprojekt WebkitWasm analysiert ([Notizen](referenz-webkitwasm.md))

## Phase 1: Dependencies nach WASM
zlib, brotli, zstd, libpng, libjpeg-turbo, libwebp, freetype, harfbuzz, fontconfig, woff2,
ICU (>= 70.1, Daten reduziert), libxml2, libxslt, sqlite, OpenSSL, nghttp2, libcurl, Skia.
Alles mit `-pthread`, gepinnt mit Hash, in ein `sysroot/`. Fonts: Noto-Set.
Test: kleines Testprogramm pro Lib.

## Phase 2: JavaScriptCore im Browser
CLoop, kein JIT. GC-Stackscanning loesen (siehe [Architektur](architektur.md)).
`jsc`-Shell als WASM. Test: test262-Teilmenge + GC-Stresstests in headless Chromium.

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
