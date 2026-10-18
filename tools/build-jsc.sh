#!/usr/bin/env bash
# JavaScriptCore (CLoop, ohne JIT) + jsc-Shell nach WASM bauen.
# Braucht ICU im sysroot (deps/build-all.sh) und den gepatchten WebKit-Baum.
#
#   tools/build-jsc.sh              # konfigurieren + bauen
#   BL_SPILL_POINTERS=0 tools/build-jsc.sh   # ohne --spill-pointers (nur zum Vergleichen)
#
# Ausgabe: build/jsc/bin/jsc.js + jsc.wasm
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

out="$BL_BUILD_DIR/jsc"
jobs="${BL_JOBS:-$(nproc)}"

[ -f "$BL_SYSROOT/lib/libicuuc.a" ] || bl_die "ICU fehlt im sysroot. Zuerst deps/build-all.sh ausfuehren."

# Link-Flags nur fuer die jsc-Shell (die LLInt-Extractors bekommen nur -pthread):
# - main() laeuft in einem Worker (PROXY_TO_PTHREAD), damit blockieren erlaubt ist
# - JSC braucht viel C-Stack (Default von Emscripten ist nur 64 KB)
# - NODERAWFS: in node direkt aufs echte Dateisystem (fuer Tests mit .js Dateien)
link_flags="-sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=4MB"
link_flags+=" -sINITIAL_MEMORY=256MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sPTHREAD_POOL_SIZE=8"
link_flags+=" -sNODERAWFS=1 -sENVIRONMENT=node,worker"
# GC-Wurzeln: JSC sucht lebende Objekte konservativ auf dem Stack. Pointer in
# WASM-Locals sieht er nicht. --spill-pointers schreibt sie vor jedem Call auf
# den Shadow-Stack im Linear Memory, den der GC scannt (siehe docs/architecture.md).
if [ "${BL_SPILL_POINTERS:-1}" = 1 ]; then
    # --profiling-funcs: behaelt die Namen im Binary, sonst findet der Pass nach
    # der Optimierung den Stack-Pointer nicht ("failed to find the stack pointer").
    # Gibt nebenbei lesbare Absturz-Stacks.
    link_flags+=" -sBINARYEN_EXTRA_PASSES=--spill-pointers --profiling-funcs"
fi

bl_log "Konfiguriere JSC ($out)"
bl_webkit_configure "$out" \
    -DPORT=JSCOnly \
    -DJSC_SHELL_LINK_OPTIONS="$link_flags" \
    -DENABLE_STATIC_JSC=ON \
    -DENABLE_JIT=OFF \
    -DENABLE_DFG_JIT=OFF \
    -DENABLE_FTL_JIT=OFF \
    -DENABLE_C_LOOP=ON \
    -DENABLE_WEBASSEMBLY=OFF \
    -DENABLE_SAMPLING_PROFILER=OFF \
    -DENABLE_API_TESTS=OFF \
    -DENABLE_REMOTE_INSPECTOR=OFF \
    -DUSE_SYSTEM_MALLOC=ON

bl_log "Baue jsc mit $jobs Jobs"
cmake --build "$out" --target jsc -j "$jobs"
bl_log "Fertig: $(find "$out/bin" -maxdepth 1 -name 'jsc.*' -printf '%f %s Bytes  ')"
