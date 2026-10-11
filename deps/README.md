# deps/

Phase 1: Build-Skripte fuer alle Dependencies (zlib, ICU, freetype, harfbuzz, fontconfig,
libxml2, sqlite, OpenSSL, nghttp2, libcurl, Skia, ...) nach WASM.

Jede Dependency bekommt ein eigenes Skript mit fixer Version und SHA256 der Quellen.
Ausgabe ist ein gemeinsames `sysroot/` (gitignored).
