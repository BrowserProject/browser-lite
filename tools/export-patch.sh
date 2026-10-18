#!/usr/bin/env bash
# Saves changes in the WebKit checkout as a new patch.
#
#   tools/export-patch.sh 0003-wtf-runloop-emscripten                 # all new changes
#   tools/export-patch.sh 0004-jsc-cmake Source/JavaScriptCore/CMakeLists.txt   # only these paths
#
# All earlier patches should be applied before (tools/apply-patches.sh puts the patched
# state into the git index). Exported paths go into the index afterwards, so they do not
# show up again in the next export.
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

name="${1:-}"
[ -n "$name" ] || bl_die "Name missing, for example tools/export-patch.sh 0001-cmake-port-wasm"
shift
out="$BL_ROOT/engine/patches/$name.patch"
[ -e "$out" ] && bl_die "$out exists already"

paths=("$@")
[ "${#paths[@]}" -gt 0 ] || paths=(.)

git -C "$BL_WEBKIT_DIR" add -A -N -- "${paths[@]}"
diff="$(git -C "$BL_WEBKIT_DIR" diff -- "${paths[@]}")"
[ -n "$diff" ] || bl_die "No new changes in the WebKit checkout (paths: ${paths[*]})"

mkdir -p "$(dirname "$out")"
printf '%s\n' "$diff" > "$out"
git -C "$BL_WEBKIT_DIR" add -A -- "${paths[@]}"
bl_log "Patch written: $out ($(grep -c '^diff --git' "$out") files)"
