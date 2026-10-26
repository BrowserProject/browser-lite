#!/usr/bin/env bash
# Packages a built engine for delivery and release:
#   <out>/engine/<hash>/engine.js, engine.wasm, engine.data   with .br and .gz next to them
#   <out>/engine/<hash>/engine.deferred.wasm                   of a split engine (#238)
#   <out>/engine/<hash>/lazy/                                   files loaded on demand (ICU data)
#   <out>/engine/<hash>/manifest.json                          tools/engine-manifest.mjs
#   <out>/engine/<hash>/THIRD_PARTY_NOTICES.txt                tools/gen-notices.mjs
# The .wasm loses its "name" section. <hash> (12 hex) is the content hash of the engine files
# and lazy/ as delivered, so a browser never takes an old engine from its cache. The notices need
# the toolchain image (run the script inside it); --no-notices skips them for local tests.
#
#   tools/package-engine.sh [--no-notices] <engine-dir> <out>
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

notices=1
if [ "${1:-}" = --no-notices ]; then
    notices=0
    shift
fi
[ "$#" -eq 2 ] || bl_die "usage: tools/package-engine.sh [--no-notices] <engine-dir> <out>"
engine_dir="$1"
out="$2"

for f in engine.js engine.wasm engine.data; do
    [ -f "$engine_dir/$f" ] || bl_die "$engine_dir/$f missing (build the engine first: tools/build-webcore.sh)"
done

# Staged next to the output: the engine is too large for a small /tmp
mkdir -p "$out"
stage="$(mktemp -d "$out/.stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
[ -d "$engine_dir/lazy" ] || bl_die "$engine_dir/lazy missing (build the engine first: tools/build-webcore.sh)"
cp "$engine_dir"/engine.js "$engine_dir"/engine.wasm "$engine_dir"/engine.data "$stage/"
if [ -f "$engine_dir/engine.deferred.wasm" ]; then
    cp "$engine_dir/engine.deferred.wasm" "$stage/"
fi
cp -r "$engine_dir/lazy" "$stage/"
node "$BL_ROOT/tools/optimize-assets.mjs" --strip-only "$stage"
hash="$( (cd "$stage" && find . -type f | LC_ALL=C sort | xargs sha256sum) | sha256sum | cut -c1-12)"

rm -rf "${out:?}/engine"
dest="$out/engine/$hash"
mkdir -p "$dest"
mv "$stage"/engine.* "$stage"/lazy "$dest/"
node "$BL_ROOT/tools/optimize-assets.mjs" "$dest"
node "$BL_ROOT/tools/engine-manifest.mjs" "$dest"
if [ "$notices" = 1 ]; then
    node "$BL_ROOT/tools/gen-notices.mjs" > "$stage/THIRD_PARTY_NOTICES.txt"
    mv "$stage/THIRD_PARTY_NOTICES.txt" "$dest/"
fi
bl_log "Engine ready in $dest ($(du -sh "$dest" | cut -f1))"
