#!/usr/bin/env bash
# Phase 2: JavaScriptCore (CLoop, ohne JIT) + jsc-Shell nach WASM bauen.
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

# Link-Flags nur fuer die jsc-Shell (die LLInt-Extractors bekommen nur -pthread):
# - main() laeuft in einem Worker (PROXY_TO_PTHREAD), damit blockieren erlaubt ist
# - JSC braucht viel C-Stack (Default von Emscripten ist nur 64 KB)
# - NODERAWFS: in node direkt aufs echte Dateisystem (fuer Tests mit .js Dateien)
link_flags="-sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=4MB"
link_flags+=" -sINITIAL_MEMORY=256MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sPTHREAD_POOL_SIZE=8"
link_flags+=" -sNODERAWFS=1 -sENVIRONMENT=node,worker"
# GC-Wurzeln: JSC sucht lebende Objekte konservativ auf dem Stack. Pointer in
# WASM-Locals sieht er nicht. --spill-pointers schreibt sie vor jedem Call auf
# den Shadow-Stack im Linear Memory, den der GC scannt (siehe docs/architektur.md).
if [ "${BL_SPILL_POINTERS:-1}" = 1 ]; then
    # --profiling-funcs: behaelt die Namen im Binary, sonst findet der Pass nach
    # der Optimierung den Stack-Pointer nicht ("failed to find the stack pointer").
    # Gibt nebenbei lesbare Absturz-Stacks.
    link_flags+=" -sBINARYEN_EXTRA_PASSES=--spill-pointers --profiling-funcs"
fi

{
    bl_log "Konfiguriere JSC ($out)"
    export PKG_CONFIG_LIBDIR="$BL_SYSROOT/lib/pkgconfig:$BL_SYSROOT/share/pkgconfig"
    emcmake cmake -S "$BL_WEBKIT_DIR" -B "$out" -G Ninja \
        -DPORT=JSCOnly \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_PREFIX_PATH="$BL_SYSROOT" \
        -DCMAKE_FIND_ROOT_PATH="$BL_SYSROOT" \
        -DCMAKE_C_FLAGS="-pthread -msimd128" \
        -DCMAKE_CXX_FLAGS="-pthread -msimd128" \
        -DCMAKE_EXE_LINKER_FLAGS="-pthread" \
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
        -DUSE_SYSTEM_MALLOC=ON \
        -DDEVELOPER_MODE=OFF \
        "${launcher[@]}"
}

bl_log "Baue jsc mit $jobs Jobs"
cmake --build "$out" --target jsc -j "$jobs"
bl_log "Fertig: $(find "$out/bin" -maxdepth 1 -name 'jsc.*' -printf '%f %s Bytes  ')"
