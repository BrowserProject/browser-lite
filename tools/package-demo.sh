#!/usr/bin/env bash
# Builds the folder the server delivers (SITE_DIR of browser-lite-server):
#   <out>/index.html, assets/, sw.js, media-sw.js       the demo (Vite build of apps/demo)
#   <out>/engine/<hash>/...                              the packaged engine
# <engine> is the output of tools/package-engine.sh (folder with engine/<hash>/manifest.json,
# CI artifact engine-dist) or a built engine folder, which is packaged here without notices.
# Files of the demo larger than 1 KB also get .br and .gz. Needs the built packages
# (npm ci && npm run build).
#
#   tools/package-demo.sh <engine> <out>
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

engine="${1:-$BL_BUILD_DIR/webcore/bin}"
out="${2:-$BL_BUILD_DIR/demo}"
[ -f "$BL_ROOT/packages/core/dist/index.js" ] || bl_die "packages not built (npm ci && npm run build)"

mkdir -p "$(dirname "$out")"
stage="$(mktemp -d "$(dirname "$out")/.engine.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
if ! compgen -G "$engine/engine/*/manifest.json" >/dev/null; then
    "$BL_ROOT/tools/package-engine.sh" --no-notices "$engine" "$stage"
    engine="$stage"
fi
manifests=("$engine"/engine/*/manifest.json)
[ "${#manifests[@]}" -eq 1 ] || bl_die "$engine/engine/ holds more than one engine"
hash="$(basename "$(dirname "${manifests[0]}")")"

rm -rf "${out:?}"
VITE_ENGINE_BASE="engine/$hash/" node "$BL_ROOT/node_modules/vite/bin/vite.js" build "$BL_ROOT/apps/demo" \
    --outDir "$(realpath -m "$out")" --emptyOutDir --logLevel warn
grep -rqF "engine/$hash/" "$out/assets" || bl_die "engine path engine/$hash/ not found in the demo build"
node "$BL_ROOT/tools/optimize-assets.mjs" "$out"
cp -r "$engine/engine" "$out/engine"
bl_log "Demo ready in $out ($(du -sh "$out" | cut -f1), engine $hash)"
