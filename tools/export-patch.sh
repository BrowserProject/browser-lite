#!/usr/bin/env bash
# Speichert die aktuellen Aenderungen im WebKit-Checkout als neuen Patch.
#
#   tools/export-patch.sh 0003-wtf-runloop-emscripten
#
# Vorher sollten alle bisherigen Patches angewendet sein (tools/apply-patches.sh).
# Der neue Patch enthaelt nur, was seit apply-patches.sh dazugekommen ist
# (apply-patches.sh legt den gepatchten Stand ins Git-Index).
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

name="${1:-}"
[ -n "$name" ] || bl_die "Name fehlt, z.B. tools/export-patch.sh 0001-cmake-port-wasm"
out="$BL_ROOT/patches/webkit/$name.patch"
[ -e "$out" ] && bl_die "$out gibt es schon"

git -C "$BL_WEBKIT_DIR" add -A -N
diff="$(git -C "$BL_WEBKIT_DIR" diff)"
[ -n "$diff" ] || bl_die "Keine neuen Aenderungen im WebKit-Checkout"

mkdir -p "$(dirname "$out")"
printf '%s\n' "$diff" > "$out"
bl_log "Patch geschrieben: $out"
