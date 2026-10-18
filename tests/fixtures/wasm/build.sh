#!/usr/bin/env bash
# Rebuilds the WebAssembly test files for tests/core/wasm-test.mjs (in the toolchain image). The
# results are checked in, CI does not build them.
set -euo pipefail
cd "$(dirname "$0")"
clang="$(dirname "$(which emcc)")/../bin/clang"
[ -x "$clang" ] || clang=/opt/emsdk/upstream/bin/clang
"$clang" --target=wasm32 -O2 -nostdlib -msimd128 -mbulk-memory -matomics -Wl,--no-entry -Wl,--export-memory -Wl,--no-check-features -o small.wasm small.c
em++ -O2 -fwasm-exceptions -msimd128 -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,node -o program.js program.cpp
em++ -O2 -fwasm-exceptions -msimd128 -sMEMORY64=1 -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,node -o program64.js program.cpp
