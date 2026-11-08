#!/usr/bin/env bash
# Runs the JSC tests with the WASM jsc shell in node.
#   tests/jsc/run.sh [path/to/jsc.js]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jsc="${1:-$here/../../build/jsc/bin/jsc.js}"
[ -f "$jsc" ] || { echo "jsc.js not found: $jsc" >&2; exit 1; }

fail=0
# Second pass with the JIT to WebAssembly (docs/jit.md)
jit=0
run() {
    local name="$1"
    shift
    [ "$jit" = 0 ] || name="$name (jit)"
    local out
    if out="$(BL_JIT=$jit node "$jsc" "$@" 2>&1)" && grep -q "^OK " <<< "$out"; then
        echo "ok    $name"
    else
        echo "FAIL  $name"
        echo "$out" | tail -20 | sed 's/^/      /'
        fail=1
    fi
}

# How often `hot` of jit-recompile.js compiles with these options (the JIT logs its compiles)
compiles() {
    BL_JIT=2 node "$jsc" "$@" "$here/jit-recompile.js" 2>&1 | grep -c '^\[jit\] hot#' || true
}

for jit in 0 1; do
run basics "$here/basics.js"
run calls "$here/calls.js"
run resizable "$here/resizable.js"
run calls-gc --slowPathAllocsBetweenGCs=10 "$here/calls.js"
run llint-caches "$here/llint-caches.js"
run llint-caches-no-ics --useLLIntICs=false "$here/llint-caches.js"
run gc-stress "$here/gc-stress.js"
# Trigger the GC very often (every few allocations)
run gc-stress-aggressive --slowPathAllocsBetweenGCs=10 "$here/gc-stress.js"
run gc-stress-collect-continuously --collectContinuously=1 "$here/gc-stress.js"
run jit "$here/jit.js"
# Speed of the JIT's fast paths for hashing code against their int32 twins
[ "$jit" = 0 ] || run jit-hash "$here/jit-hash.js"
# A loop entered once gets V8's optimized code too
[ "$jit" = 0 ] || run jit-tierup "$here/jit-tierup.js"
# Calls: many callees at one site, compiled callees in WASM
[ "$jit" = 0 ] || run jit-calls "$here/jit-calls.js"
done

# Compiled code stays through a full GC of old code, code thrown away compiles again
kept="$(compiles)"
again="$(compiles --forceCodeBlockToJettisonDueToOldAge=true)"
if [ "$kept" = 1 ] && [ "$again" = 2 ]; then
    echo "ok    jit-recompile (jit)"
else
    echo "FAIL  jit-recompile (jit): compiled $kept times through a GC (expected 1), $again times after the code was thrown away (expected 2)"
    fail=1
fi

exit $fail
