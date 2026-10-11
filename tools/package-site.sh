#!/usr/bin/env bash
# Baut den Ordner, der auf den Webserver kommt:
#   <ziel>/index.html, app.js, transport.js, style.css
#   <ziel>/engine/engine.js, engine.wasm, engine.data
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

mkdir -p "$target/engine"
cp "$BL_ROOT"/web/index.html "$BL_ROOT"/web/app.js "$BL_ROOT"/web/transport.js "$BL_ROOT"/web/style.css "$target/"
cp "$engine_dir"/engine.js "$engine_dir"/engine.wasm "$engine_dir"/engine.data "$target/engine/"

# Version in die Seite schreiben, damit Browser keine alte Engine aus dem Cache nehmen
version="$(git -C "$BL_ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
sed -i "s|src=\"app.js\"|src=\"app.js?v=$version\"|; s|href=\"style.css\"|href=\"style.css?v=$version\"|" "$target/index.html"
sed -i "s|'engine/engine.js'|'engine/engine.js?v=$version'|" "$target/app.js"
bl_log "Seite fertig in $target ($(du -sh "$target" | cut -f1), Version $version)"
