# deps/

Die Bibliotheken der Engine (zlib, ICU, freetype, harfbuzz, fontconfig, libxml2, sqlite,
OpenSSL, nghttp2, libcurl, ...), nach WASM gebaut. Skia kommt mit WebKit.

- `sources.txt`: Quelle jeder Lib mit Version und SHA256 (bzw. Git-Commit). Nur hier stehen
  Versionen.
- `recipes/<name>.sh`: wie eine Lib gebaut wird (Funktion `build`). Liest ein Rezept weitere
  Dateien (z.B. `tools/fc-precache.c`), stehen sie in `DEP_FILES`.
- `build-all.sh`: Reihenfolge und Stamps. Baut nur, was sich geaendert hat, und alles danach.
- `test.sh`: Smoke-Test gegen das fertige sysroot (`tests/smoke.cpp`).

Ausgabe: `sysroot/` (Header, statische Libs, pkg-config) und `sysroot/runtime/` (Fonts,
fontconfig, CA-Zertifikate), das beim Linken der Engine zu `engine.data` wird. Beides ist
gitignored. Bauen siehe [docs/build.md](../docs/build.md).

OpenSSL, curl und die CA-Zertifikate (`cacert`) regelmaessig aktualisieren: sie verarbeiten
Daten beliebiger Server, und das Zertifikat-Bundle ist fest in der Engine.
