#!/usr/bin/env bash
# Fuehrt die JSC-Tests mit der WASM-jsc-Shell in node aus.
#   tests/jsc/run.sh [pfad/zu/jsc.js]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jsc="${1:-$here/../../build/jsc/bin/jsc.js}"
[ -f "$jsc" ] || { echo "jsc.js nicht gefunden: $jsc" >&2; exit 1; }

fail=0
run() {
    local name="$1"
    shift
    local out
    if out="$(node "$jsc" "$@" 2>&1)" && grep -q "^OK " <<< "$out"; then
        echo "ok    $name"
    else
        echo "FAIL  $name"
        echo "$out" | tail -20 | sed 's/^/      /'
        fail=1
    fi
}

run basics "$here/basics.js"
run calls "$here/calls.js"
run resizable "$here/resizable.js"
run calls-gc --slowPathAllocsBetweenGCs=10 "$here/calls.js"
run llint-caches "$here/llint-caches.js"
run llint-caches-no-ics --useLLIntICs=false "$here/llint-caches.js"
run gc-stress "$here/gc-stress.js"
# GC sehr oft ausloesen (alle paar Allokationen)
run gc-stress-aggressive --slowPathAllocsBetweenGCs=10 "$here/gc-stress.js"
run gc-stress-collect-continuously --collectContinuously=1 "$here/gc-stress.js"

exit $fail
