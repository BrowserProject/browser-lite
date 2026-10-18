#!/usr/bin/env bash
# Resets the WebKit checkout to the pinned commit and applies all patches of
# engine/patches/ in order (sorted by file name).
#
#   tools/apply-patches.sh          # reset + apply
#   tools/apply-patches.sh --check  # only check that everything applies cleanly
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

mode="apply"
[ "${1:-}" = "--check" ] && mode="check"

[ -d "$BL_WEBKIT_DIR/.git" ] || bl_die "No WebKit checkout. Run tools/fetch-webkit.sh first."

bl_log "Resetting WebKit to ${WEBKIT_COMMIT:0:12}"
git -C "$BL_WEBKIT_DIR" reset -q --hard "$WEBKIT_COMMIT"
git -C "$BL_WEBKIT_DIR" clean -q -fd

shopt -s nullglob
patches=("$BL_ROOT"/engine/patches/*.patch)
if [ "${#patches[@]}" -eq 0 ]; then
    bl_log "No patches, nothing to do"
    exit 0
fi

for p in "${patches[@]}"; do
    name="$(basename "$p")"
    git -C "$BL_WEBKIT_DIR" apply --check "$p" || bl_die "Patch does not apply: $name"
    if [ "$mode" = "apply" ]; then
        git -C "$BL_WEBKIT_DIR" apply "$p"
        bl_log "applied: $name"
    else
        # For --check later patches must be able to build on the earlier ones.
        git -C "$BL_WEBKIT_DIR" apply "$p"
        bl_log "ok: $name"
    fi
done

if [ "$mode" = "check" ]; then
    git -C "$BL_WEBKIT_DIR" reset -q --hard "$WEBKIT_COMMIT"
    git -C "$BL_WEBKIT_DIR" clean -q -fd
else
    # Put the state after all patches into the index, so tools/export-patch.sh
    # later exports only new changes.
    git -C "$BL_WEBKIT_DIR" add -A
fi
bl_log "${#patches[@]} Patch(es) ok"
