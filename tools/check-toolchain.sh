#!/usr/bin/env bash
# Prueft ob alle Tools da sind und Emscripten ein kleines Programm mit pthreads
# bauen und ausfuehren kann. Laeuft im Toolchain-Image (lokal und CI).
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

missing=""
for t in emcc em++ emcmake node cmake ninja perl python3 ruby gperf unifdef pkg-config git; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
[ -z "$missing" ] || bl_die "Es fehlen Tools:$missing"

emver="$(emcc -dumpversion)"
[ "$emver" = "$EMSDK_VERSION" ] || bl_die "emcc ist $emver, erwartet $EMSDK_VERSION (versions.env)"
bl_log "emcc $emver ok"

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
[ "$out" = "hello from wasm, counter=42" ] || bl_die "Testprogramm hat falsche Ausgabe"
bl_log "Toolchain ok"
