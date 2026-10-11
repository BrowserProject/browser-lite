#!/usr/bin/env bash
# Phase 3: WebKit mit unserem PORT=Wasm bauen (WTF, JavaScriptCore, PAL, WebCore).
# Braucht das komplette sysroot (deps/build-all.sh) und den gepatchten WebKit-Baum.
#
#   tools/build-webcore.sh                 # konfigurieren + Engine bauen (WebCore + engine/)
#   tools/build-webcore.sh <ninja-target>  # anderes Target (z.B. WebCore)
#
# Ausgabe: build/webcore/bin/engine.js, engine.wasm, engine.data
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

out="$BL_BUILD_DIR/webcore"
jobs="${BL_JOBS:-$(nproc)}"
target="${1:-BrowserLiteEngine}"

[ -f "$BL_SYSROOT/lib/libcurl.a" ] || bl_die "sysroot unvollstaendig. Zuerst deps/build-all.sh ausfuehren."
command -v emcmake >/dev/null || bl_die "emcmake fehlt (im Toolchain-Image ausfuehren)"
# sysroot kann aus einem anderen Pfad kommen (CI-Artefakt)
"$BL_ROOT/deps/relocate-pc.sh" "$BL_SYSROOT"

launcher=()
if command -v ccache >/dev/null; then
    launcher=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
    # WebKit nutzt Precompiled Headers. Ohne diese Einstellung kann ccache
    # 60% der Aufrufe nicht cachen ("Could not use precompiled header").
    export CCACHE_SLOPPINESS="${CCACHE_SLOPPINESS:-pch_defines,time_macros,include_file_mtime,include_file_ctime}"
fi

bl_log "Konfiguriere WebKit PORT=Wasm ($out)"
export PKG_CONFIG_LIBDIR="$BL_SYSROOT/lib/pkgconfig:$BL_SYSROOT/share/pkgconfig"
emcmake cmake -S "$BL_WEBKIT_DIR" -B "$out" -G Ninja \
    -DPORT=Wasm \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$BL_SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$BL_SYSROOT" \
    -DCMAKE_C_FLAGS="-pthread -msimd128" \
    -DCMAKE_CXX_FLAGS="-pthread -msimd128" \
    -DCMAKE_EXE_LINKER_FLAGS="-pthread" \
    -DDEVELOPER_MODE=OFF \
    -DBROWSER_LITE_ENGINE_DIR="$BL_ROOT/engine" \
    -DBROWSER_LITE_RUNTIME_DIR="$BL_SYSROOT/runtime" \
    "${launcher[@]}"

bl_log "Baue $target mit $jobs Jobs"
cmake --build "$out" --target "$target" -j "$jobs"
bl_log "Fertig: $(find "$out/bin" -maxdepth 1 -name 'engine.*' -printf '%f %s Bytes  ' 2>/dev/null)"
