#!/usr/bin/env bash
# Checks that all tools are there and that Emscripten can build and run a small
# program with pthreads. Runs in the toolchain image (locally and in CI).
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

missing=""
for t in emcc em++ emcmake node cmake ninja perl python3 ruby gperf unifdef pkg-config git; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
[ -z "$missing" ] || bl_die "Tools missing:$missing"

emver="$(emcc -dumpversion)"
[ "$emver" = "$EMSDK_VERSION" ] || bl_die "emcc is $emver, expected $EMSDK_VERSION (versions.env)"
bl_log "emcc $emver ok"
mesonver="$(meson --version)"
[ "$mesonver" = "$MESON_VERSION" ] || bl_die "meson is $mesonver, expected $MESON_VERSION (versions.env)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/hello.cpp" <<'CPP'
#include <atomic>
#include <cstdio>
#include <thread>

int main()
{
    std::atomic<int> counter { 0 };
    std::thread worker([&] { counter += 41; });
    worker.join();
    counter++;
    std::printf("hello from wasm, counter=%d\n", counter.load());
    return counter == 42 ? 0 : 1;
}
CPP
em++ -O2 -pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME -o "$tmp/hello.js" "$tmp/hello.cpp"
out="$(node "$tmp/hello.js")"
echo "$out"
[ "$out" = "hello from wasm, counter=42" ] || bl_die "Test program printed the wrong output"
bl_log "Toolchain ok"
