#!/usr/bin/env bash
# Builds the folder the server delivers (SITE_DIR of browser-lite-server):
#   <out>/index.html, assets/, sw.js, media-sw.js       the demo (Vite build of apps/demo)
#   <out>/engine/<hash>/...                              the packaged engine
# <engine> is the output of tools/package-engine.sh (folder with engine/<hash>/manifest.json,
# CI artifact engine-dist) or a built engine folder, which is packaged here without notices.
# Files of the demo larger than 1 KB also get .br and .gz. With <previous>, the folder of the
# demo deployed so far, its engine stays in engine/<old hash>/ (open tabs still find their files)
# and the files of the new engine get deltas against it (tools/engine-deltas.mjs, #244). Needs the
# built packages (npm ci && npm run build).
#
#   tools/package-demo.sh <engine> <out> [<previous>]
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

engine="${1:-$BL_BUILD_DIR/webcore/bin}"
out="${2:-$BL_BUILD_DIR/demo}"
previous="${3:-}"
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
if [ -n "$previous" ]; then
    # The engine the previous demo loads (its folder name is in its app script)
    old="$( (grep -rhoE 'engine/[0-9a-f]{12}/' "$previous/assets" 2>/dev/null || true) | sort -u | sed 's|engine/||; s|/||')"
    if [ "$(wc -w <<<"$old")" -ne 1 ] || [ ! -d "$previous/engine/$old" ]; then
        bl_log "No single engine in $previous, no deltas"
    elif [ "$old" != "$hash" ]; then
        cp -r "$previous/engine/$old" "$out/engine/$old"
        find "$out/engine/$old" -name '*.dcz' -delete
        node "$BL_ROOT/tools/engine-deltas.mjs" "$out/engine/$hash" "$out/engine/$old"
    fi
fi
bl_log "Demo ready in $out ($(du -sh "$out" | cut -f1), engine $hash)"
