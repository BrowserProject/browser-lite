#!/usr/bin/env bash
# Builds deps/tests/smoke.cpp against the sysroot and runs it with node.
set -euo pipefail
# shellcheck source=deps/lib.sh
source "$(dirname "$0")/lib.sh"

out="$BL_DEPS_BUILD/smoke"
mkdir -p "$out"

pkgs="libcurl libpsl harfbuzz-icu harfbuzz fontconfig freetype2 icu-i18n icu-uc libxslt libxml-2.0 sqlite3 libwebpdemux libwebp libjpeg libpng zlib libzstd libbrotlidec libwoff2dec libnghttp2 openssl expat"
# shellcheck disable=SC2046,SC2086
em++ $BL_CXXFLAGS -o "$out/smoke.js" "$BL_DEPS_DIR/tests/smoke.cpp" \
    $(pkg-config --cflags --static $pkgs) \
    $(pkg-config --libs --static $pkgs) \
    -sPROXY_TO_PTHREAD -sEXIT_RUNTIME -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB

bl_log "smoke.wasm: $(du -h "$out/smoke.wasm" | cut -f1)"
node "$out/smoke.js"
