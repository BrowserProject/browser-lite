#!/usr/bin/env bash
# Builds the folder the server delivers (SITE_DIR of browser-lite-server):
#   <out>/index.html, assets/, sw.js, media-sw.js       the demo (Vite build of apps/demo)
#   <out>/engine/<hash>/engine.js, engine.wasm, engine.data
# <hash> is the content hash of the engine files, so a browser never takes an old engine from its
# cache. Everything larger than 1 KB also gets .br and .gz. Needs the built packages
# (npm ci && npm run build).
#
#   tools/package-demo.sh <engine-dir> <out>
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

engine_dir="${1:-$BL_BUILD_DIR/webcore/bin}"
out="${2:-$BL_BUILD_DIR/demo}"

for f in engine.js engine.wasm engine.data; do
    [ -f "$engine_dir/$f" ] || bl_die "$engine_dir/$f missing (build the engine first: tools/build-webcore.sh)"
done
[ -f "$BL_ROOT/packages/core/dist/index.js" ] || bl_die "packages not built (npm ci && npm run build)"

# The hash covers the files as delivered: without the name section of the .wasm
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$engine_dir"/engine.js "$engine_dir"/engine.wasm "$engine_dir"/engine.data "$stage/"
node "$BL_ROOT/tools/optimize-assets.mjs" --strip-only "$stage"
hash="$(cat "$stage"/engine.js "$stage"/engine.wasm "$stage"/engine.data | sha256sum | cut -c1-16)"

rm -rf "${out:?}"
VITE_ENGINE_BASE="engine/$hash/" node "$BL_ROOT/node_modules/vite/bin/vite.js" build "$BL_ROOT/apps/demo" \
    --outDir "$(realpath -m "$out")" --emptyOutDir --logLevel warn
mkdir -p "$out/engine/$hash"
cp "$stage"/engine.js "$stage"/engine.wasm "$stage"/engine.data "$out/engine/$hash/"
grep -rqF "engine/$hash/" "$out/assets" || bl_die "engine path engine/$hash/ not found in the demo build"

node "$BL_ROOT/tools/optimize-assets.mjs" "$out"
bl_log "Demo ready in $out ($(du -sh "$out" | cut -f1), engine $hash)"
