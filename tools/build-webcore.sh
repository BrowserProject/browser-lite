#!/usr/bin/env bash
# Builds WebKit with our PORT=Wasm (WTF, JavaScriptCore, PAL, WebCore) and the engine.
# Needs the complete sysroot (deps/build-all.sh) and the patched WebKit tree.
#
#   tools/build-webcore.sh                 # configure + build the engine (WebCore + engine/)
#   tools/build-webcore.sh <ninja-target>  # another target (for example WebCore)
#
# Output: build/webcore/bin/engine.js, engine.wasm, engine.data and lazy/ (files loaded on demand)
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

out="$BL_BUILD_DIR/webcore"
jobs="${BL_JOBS:-$(nproc)}"
target="${1:-BrowserLiteEngine}"

[ -f "$BL_SYSROOT/lib/libcurl.a" ] || bl_die "sysroot incomplete. Run deps/build-all.sh first."
icu_data=("$BL_SYSROOT"/share/icu/icudt*l.dat)
[ -f "${icu_data[0]}" ] || bl_die "ICU data archive missing in $BL_SYSROOT/share/icu (deps/build-all.sh)"

bl_log "Configuring WebKit PORT=Wasm ($out)"
bl_webkit_configure "$out" \
    -DPORT=Wasm \
    -DBROWSER_LITE_ENGINE_DIR="$BL_ROOT/engine" \
    -DBROWSER_LITE_RUNTIME_DIR="$BL_SYSROOT/runtime" \
    -DBROWSER_LITE_ICU_DATA="${icu_data[0]}" \
    -DBROWSER_LITE_LAZY_FONTS="$BL_SYSROOT/lazy/fonts"

bl_log "Building $target with $jobs jobs"
cmake --build "$out" --target "$target" -j "$jobs"
bl_log "Done: $(find "$out/bin" -maxdepth 1 -name 'engine.*' -printf '%f %s bytes  ' 2>/dev/null)"
