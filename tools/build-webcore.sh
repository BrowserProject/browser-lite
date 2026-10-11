#!/usr/bin/env bash
# Phase 3: WebKit mit unserem PORT=Wasm bauen (WTF, JavaScriptCore, PAL, WebCore).
# Braucht das komplette sysroot (deps/build-all.sh) und den gepatchten WebKit-Baum.
#
#   tools/build-webcore.sh                 # konfigurieren + WebCore bauen
#   tools/build-webcore.sh <ninja-target>  # anderes Target (z.B. JavaScriptCore)
#
# Ausgabe: statische Libs in build/webcore/lib/
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

out="$BL_BUILD_DIR/webcore"
jobs="${BL_JOBS:-$(nproc)}"
target="${1:-WebCore}"

[ -f "$BL_SYSROOT/lib/libcurl.a" ] || bl_die "sysroot unvollstaendig. Zuerst deps/build-all.sh ausfuehren."
command -v emcmake >/dev/null || bl_die "emcmake fehlt (im Toolchain-Image ausfuehren)"

launcher=()
if command -v ccache >/dev/null; then
    launcher=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
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
    "${launcher[@]}"

bl_log "Baue $target mit $jobs Jobs"
cmake --build "$out" --target "$target" -j "$jobs"
bl_log "Fertig: $(find "$out/lib" -maxdepth 1 -name '*.a' -printf '%f ' 2>/dev/null)"
