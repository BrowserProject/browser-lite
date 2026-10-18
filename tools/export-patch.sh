#!/usr/bin/env bash
# Speichert Aenderungen im WebKit-Checkout als neuen Patch.
#
#   tools/export-patch.sh 0003-wtf-runloop-emscripten                 # alle neuen Aenderungen
#   tools/export-patch.sh 0004-jsc-cmake Source/JavaScriptCore/CMakeLists.txt   # nur diese Pfade
#
# Vorher sollten alle bisherigen Patches angewendet sein (tools/apply-patches.sh
# legt den gepatchten Stand ins Git-Index). Exportierte Pfade werden danach ins
# Index uebernommen, damit sie beim naechsten Export nicht nochmal auftauchen.
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

name="${1:-}"
[ -n "$name" ] || bl_die "Name fehlt, z.B. tools/export-patch.sh 0001-cmake-port-wasm"
shift
out="$BL_ROOT/engine/patches/$name.patch"
[ -e "$out" ] && bl_die "$out gibt es schon"

paths=("$@")
[ "${#paths[@]}" -gt 0 ] || paths=(.)

git -C "$BL_WEBKIT_DIR" add -A -N -- "${paths[@]}"
diff="$(git -C "$BL_WEBKIT_DIR" diff -- "${paths[@]}")"
[ -n "$diff" ] || bl_die "Keine neuen Aenderungen im WebKit-Checkout (Pfade: ${paths[*]})"

mkdir -p "$(dirname "$out")"
printf '%s\n' "$diff" > "$out"
git -C "$BL_WEBKIT_DIR" add -A -- "${paths[@]}"
bl_log "Patch geschrieben: $out ($(grep -c '^diff --git' "$out") Dateien)"
