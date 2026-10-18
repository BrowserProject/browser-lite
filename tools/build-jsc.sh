#!/usr/bin/env bash
# Builds JavaScriptCore (CLoop, no JIT) and the jsc shell for WASM.
# Needs ICU in the sysroot (deps/build-all.sh) and the patched WebKit tree.
#
#   tools/build-jsc.sh              # configure + build
#   BL_SPILL_POINTERS=0 tools/build-jsc.sh   # without --spill-pointers (only for comparisons)
#
# Output: build/jsc/bin/jsc.js + jsc.wasm
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

out="$BL_BUILD_DIR/jsc"
jobs="${BL_JOBS:-$(nproc)}"

[ -f "$BL_SYSROOT/lib/libicuuc.a" ] || bl_die "ICU missing in the sysroot. Run deps/build-all.sh first."

# Link flags only for the jsc shell (the LLInt extractors get only -pthread):
# - main() runs in a worker (PROXY_TO_PTHREAD), so blocking is allowed
# - JSC needs a lot of C stack (the Emscripten default is only 64 KB)
# - NODERAWFS: in node directly on the real file system (for tests with .js files)
link_flags="-sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=4MB"
link_flags+=" -sINITIAL_MEMORY=256MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sPTHREAD_POOL_SIZE=8"
link_flags+=" -sNODERAWFS=1 -sENVIRONMENT=node,worker"
# GC roots: JSC looks for live objects conservatively on the stack. It does not see
# pointers in WASM locals. --spill-pointers writes them to the shadow stack in linear
# memory before every call, and the GC scans that (see docs/architecture.md).
if [ "${BL_SPILL_POINTERS:-1}" = 1 ]; then
    # --profiling-funcs keeps the names in the binary, otherwise the pass does not find
    # the stack pointer after optimization ("failed to find the stack pointer").
    # Also gives readable crash stacks.
    link_flags+=" -sBINARYEN_EXTRA_PASSES=--spill-pointers --profiling-funcs"
fi

bl_log "Configuring JSC ($out)"
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

bl_log "Building jsc with $jobs jobs"
cmake --build "$out" --target jsc -j "$jobs"
bl_log "Done: $(find "$out/bin" -maxdepth 1 -name 'jsc.*' -printf '%f %s bytes  ')"
