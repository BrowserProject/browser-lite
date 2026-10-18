#!/usr/bin/env bash
# Fetches exactly the pinned WebKit commit (shallow + sparse), without the huge
# test folders. Result: third_party/WebKit. Can run any number of times.
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

# Folders we do not need (many GB together). Of ANGLE only the headers
# (WebGL goes directly to the WebGL2 of the host browser, without building ANGLE).
SPARSE_PATTERNS='/*
!/LayoutTests/
!/JSTests/
!/PerformanceTests/
!/ManualTests/
!/Websites/
!/WebDriverTests/
!/Source/ThirdParty/libwebrtc/
!/Source/ThirdParty/ANGLE/
/Source/ThirdParty/ANGLE/include/
!/Source/WebInspectorUI/
'

if [ ! -d "$BL_WEBKIT_DIR/.git" ]; then
    bl_log "Initializing $BL_WEBKIT_DIR"
    mkdir -p "$BL_WEBKIT_DIR"
    git -C "$BL_WEBKIT_DIR" init -q
    git -C "$BL_WEBKIT_DIR" remote add origin "$WEBKIT_REPO"
fi

git -C "$BL_WEBKIT_DIR" config core.sparseCheckout true
git -C "$BL_WEBKIT_DIR" config core.sparseCheckoutCone false
printf '%s' "$SPARSE_PATTERNS" > "$BL_WEBKIT_DIR/.git/info/sparse-checkout"

current="$(git -C "$BL_WEBKIT_DIR" rev-parse -q --verify HEAD 2>/dev/null || true)"
if [ "$current" = "$WEBKIT_COMMIT" ]; then
    bl_log "WebKit is already at $WEBKIT_TAG (${WEBKIT_COMMIT:0:12})"
    # Take changed patterns (for example new folders), local changes stay
    git -C "$BL_WEBKIT_DIR" sparse-checkout reapply
else
    bl_log "Fetching WebKit $WEBKIT_TAG (${WEBKIT_COMMIT:0:12}), shallow"
    # Without blobs (--filter=blob:none): checkout loads the actual files, so checkout
    # needs the retry as well
    bl_retry git -C "$BL_WEBKIT_DIR" fetch -q --depth 1 --filter=blob:none origin "$WEBKIT_COMMIT"
    bl_retry git -C "$BL_WEBKIT_DIR" -c advice.detachedHead=false checkout -q -f FETCH_HEAD
fi

actual="$(git -C "$BL_WEBKIT_DIR" rev-parse HEAD)"
[ "$actual" = "$WEBKIT_COMMIT" ] || bl_die "Wrong commit: $actual instead of $WEBKIT_COMMIT"
bl_log "Done: $(du -sh "$BL_WEBKIT_DIR" --exclude=.git | cut -f1) of sources in $BL_WEBKIT_DIR"
