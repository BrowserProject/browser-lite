#!/usr/bin/env bash
# WebKit mit unserem PORT=Wasm bauen (WTF, JavaScriptCore, PAL, WebCore).
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

bl_log "Konfiguriere WebKit PORT=Wasm ($out)"
bl_webkit_configure "$out" \
    -DPORT=Wasm \
    -DBROWSER_LITE_ENGINE_DIR="$BL_ROOT/engine" \
    -DBROWSER_LITE_RUNTIME_DIR="$BL_SYSROOT/runtime"

bl_log "Baue $target mit $jobs Jobs"
cmake --build "$out" --target "$target" -j "$jobs"
bl_log "Fertig: $(find "$out/bin" -maxdepth 1 -name 'engine.*' -printf '%f %s Bytes  ' 2>/dev/null)"
