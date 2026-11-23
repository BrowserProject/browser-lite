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
# Two shapes at one property read: both cached, right after changes and GCs, as fast as one
run llint-two-shapes "$here/llint-two-shapes.js"
run gc-stress "$here/gc-stress.js"
# Trigger the GC very often (every few allocations)
run gc-stress-aggressive --slowPathAllocsBetweenGCs=10 "$here/gc-stress.js"
run gc-stress-collect-continuously --collectContinuously=1 "$here/gc-stress.js"
run jit "$here/jit.js"
# Array literals and getters from compiled code, also while the GC collects continuously
run jit-literals "$here/jit-literals.js"
run jit-literals-gc --collectContinuously=1 "$here/jit-literals.js"
# Speed of the JIT's fast paths for hashing code against their int32 twins
[ "$jit" = 0 ] || run jit-hash "$here/jit-hash.js"
# A loop entered once gets V8's optimized code too
[ "$jit" = 0 ] || run jit-tierup "$here/jit-tierup.js"
# Calls: many callees at one site, compiled callees in WASM
[ "$jit" = 0 ] || run jit-calls "$here/jit-calls.js"
# Keyed reads and writes: many keys and shapes at one site through the megamorphic cache
[ "$jit" = 0 ] || run jit-keyed "$here/jit-keyed.js"
# Array literals without a call into C++, getters without a VM entry
[ "$jit" = 0 ] || run jit-literal-speed "$here/jit-literal-speed.js"
# Global and closure variables through the inline fast path of their resolve type
[ "$jit" = 0 ] || run jit-scope "$here/jit-scope.js"
# Element reads of int32 and contiguous arrays inline where the site's profile saw only those
[ "$jit" = 0 ] || run jit-elements "$here/jit-elements.js"
# The warm-up's bookkeeping with thousands of warm functions costs no more than with a few hundred
[ "$jit" = 0 ] || run jit-warmup-map "$here/jit-warmup-map.js"
done

# The module of a large VM-like function: wasm bytes per byte of bytecode (fast paths of scope
# and element access in functions of the module, not inline at every site)
size="$(BL_JIT=2 node "$jsc" "$here/jit-size.js" 2>&1 | sed -n 's/^\[jit\] vmDispatch#.*LLIntFunctionCall, \([0-9]*\)\]: \([0-9]*\) bytes.*/\2 \1/p' | head -1)"
if [ -n "$size" ] && [ "$(awk -v s="$size" 'BEGIN { split(s, a, " "); print (a[1] <= 12 * a[2]) }')" = 1 ]; then
    echo "ok    jit-size (jit): $size"
else
    echo "FAIL  jit-size (jit): module and bytecode bytes '$size' (at most 12 times the bytecode)"
    fail=1
fi

# Bytes of WASM per statement (the dispatch with 5 copies of a statement against 1 in its 200
# cases): at most half of what they were with everything inline (about 260 and 230)
for kind in ifmov:130 xor:115; do
    name="${kind%%:*}"
    limit="${kind#*:}"
    per="$(BL_JIT=2 node "$jsc" "$here/jit-size.js" 2>&1 | sed -n "s/^\[jit\] stmt_${name}_\([15]\)#.*: \([0-9]*\) bytes.*/\1 \2/p" | sort | awk '{ size[$1] = $2 } END { if (size[1] && size[5]) printf "%.0f", (size[5] - size[1]) / 800 }')"
    if [ -n "$per" ] && [ "$per" -le "$limit" ]; then
        echo "ok    jit-size $name (jit): $per bytes per statement"
    else
        echo "FAIL  jit-size $name (jit): '$per' bytes per statement (at most $limit)"
        fail=1
    fi
done

# The branch hints of the large VM-like function's module (BL_JIT=3 writes the modules into the
# working directory): valid, so V8 keeps the code that rarely runs out of the instruction cache
dump="$(mktemp -d)"
if hints="$(cd "$dump" && BL_JIT=3 node "$jsc" "$here/jit-size.js" > /dev/null 2>&1; node "$here/jit-branch-hints.mjs" "$dump"/jit-*.wasm 2>&1)" && grep -q "^OK " <<< "$hints"; then
    echo "ok    jit-branch-hints (jit): ${hints#OK }"
else
    echo "FAIL  jit-branch-hints (jit): $hints"
    fail=1
fi
rm -rf "$dump"

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
