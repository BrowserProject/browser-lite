#!/usr/bin/env bash
# Baut die WebAssembly-Testdateien fuer tests/e2e/wasm-test.mjs neu
# (im Toolchain-Image). Die Ergebnisse sind eingecheckt, CI baut sie nicht.
set -euo pipefail
cd "$(dirname "$0")"
clang="$(dirname "$(which emcc)")/../bin/clang"
[ -x "$clang" ] || clang=/opt/emsdk/upstream/bin/clang
"$clang" --target=wasm32 -O2 -nostdlib -msimd128 -mbulk-memory -matomics -Wl,--no-entry -Wl,--export-memory -Wl,--no-check-features -o small.wasm small.c
em++ -O2 -fwasm-exceptions -msimd128 -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,node -o program.js program.cpp
