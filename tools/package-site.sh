#!/usr/bin/env bash
# Baut den Ordner, der auf den Webserver kommt:
#   <ziel>/index.html, app.js, transport.js, audio.js, audio-worklet.js, media.js, sw.js, style.css
#   <ziel>/engine/<version>/engine.js, engine.wasm, engine.data (+ .br/.gz)
#
#   tools/package-site.sh <engine-ordner> <ziel>
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

engine_dir="${1:-$BL_BUILD_DIR/webcore/bin}"
target="${2:-$BL_BUILD_DIR/site}"

for f in engine.js engine.wasm engine.data; do
    [ -f "$engine_dir/$f" ] || bl_die "$engine_dir/$f fehlt (zuerst tools/build-webcore.sh)"
done

# Version: Engine kommt in engine/<version>/, so gibt es nach einem Update
# keine alten Dateien aus dem Browser-Cache
version="$(git -C "$BL_ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"

rm -rf "${target:?}/engine"
mkdir -p "$target/engine/$version"
cp "$BL_ROOT"/web/index.html "$BL_ROOT"/web/app.js "$BL_ROOT"/web/transport.js "$BL_ROOT"/web/audio.js \
    "$BL_ROOT"/web/audio-worklet.js "$BL_ROOT"/web/media.js "$BL_ROOT"/web/sw.js "$BL_ROOT"/web/style.css "$target/"
cp "$engine_dir"/engine.js "$engine_dir"/engine.wasm "$engine_dir"/engine.data "$target/engine/$version/"

sed -i "s|src=\"app.js\"|src=\"app.js?v=$version\"|; s|href=\"style.css\"|href=\"style.css?v=$version\"|" "$target/index.html"
sed -i "s|const ENGINE_BASE = 'engine/';|const ENGINE_BASE = 'engine/$version/';|" "$target/app.js"
sed -i "s|from './transport.js'|from './transport.js?v=$version'|; s|from './audio.js'|from './audio.js?v=$version'|; s|from './media.js'|from './media.js?v=$version'|" "$target/app.js"
grep -q "engine/$version/" "$target/app.js" || bl_die "ENGINE_BASE in app.js nicht gefunden"

# Funktionsnamen entfernen, vorkomprimieren (.br/.gz)
node "$BL_ROOT/tools/optimize-site.mjs" "$target"
bl_log "Seite fertig in $target ($(du -sh "$target" | cut -f1), Version $version)"
