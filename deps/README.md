# deps/

Die Bibliotheken der Engine (zlib, ICU, freetype, harfbuzz, fontconfig, libxml2, sqlite,
OpenSSL, nghttp2, libcurl, ...), nach WASM gebaut. Skia kommt mit WebKit.

- `sources.txt`: Quelle jeder Lib mit Version und SHA256 (bzw. Git-Commit). Nur hier stehen
  ihre Versionen.
- `recipes/<name>.sh`: wie eine Lib gebaut wird (Funktion `build`). Liest ein Rezept weitere
  Dateien (z.B. `deps/tools/fc-precache.c`), stehen sie in `DEP_FILES` und zaehlen zum
  Stamp.
- `build-all.sh`: Reihenfolge und Stamps. Baut ab der ersten Lib, die sich geaendert hat, neu
  (`--force` alles, `--only <name>` nur eine).
- `lib.sh`: gemeinsame Helfer der Rezepte (Flags, Download mit Pruefsumme, cmake, meson,
  autotools).
- `relocate-pc.sh`: passt die pkg-config-Dateien an den Pfad des sysroot an.
- `test.sh`: Smoke-Test gegen das fertige sysroot (`tests/smoke.cpp`).

Ausgabe: `sysroot/` (Header, statische Libs, pkg-config) und `sysroot/runtime/` (Fonts,
fontconfig, CA-Zertifikate), das beim Linken der Engine zu `engine.data` wird. Beides ist
gitignored. Bauen siehe [docs/build.md](../docs/build.md).

OpenSSL, curl und die CA-Zertifikate (`cacert`) regelmaessig aktualisieren: sie verarbeiten
Daten beliebiger Server, und das Zertifikat-Bundle ist fest in der Engine.
