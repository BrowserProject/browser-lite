#!/usr/bin/env bash
# Holt genau den gepinnten WebKit-Commit (shallow + sparse), ohne die riesigen
# Test-Ordner. Ergebnis: third_party/WebKit. Kann beliebig oft laufen.
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

# Ordner, die wir nicht brauchen (zusammen viele GB). JSTests/test262 holen wir
# in Phase 2 separat, wenn wir es fuer Tests brauchen. Von ANGLE nur die Header
# (WebGL geht direkt auf das WebGL2 des Host-Browsers, ohne ANGLE zu bauen).
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
    bl_log "Initialisiere $BL_WEBKIT_DIR"
    mkdir -p "$BL_WEBKIT_DIR"
    git -C "$BL_WEBKIT_DIR" init -q
    git -C "$BL_WEBKIT_DIR" remote add origin "$WEBKIT_REPO"
fi

git -C "$BL_WEBKIT_DIR" config core.sparseCheckout true
git -C "$BL_WEBKIT_DIR" config core.sparseCheckoutCone false
printf '%s' "$SPARSE_PATTERNS" > "$BL_WEBKIT_DIR/.git/info/sparse-checkout"

current="$(git -C "$BL_WEBKIT_DIR" rev-parse -q --verify HEAD 2>/dev/null || true)"
if [ "$current" = "$WEBKIT_COMMIT" ]; then
    bl_log "WebKit ist schon auf $WEBKIT_TAG (${WEBKIT_COMMIT:0:12})"
    # Geaenderte Muster (z.B. neue Ordner) uebernehmen, lokale Aenderungen bleiben
    git -C "$BL_WEBKIT_DIR" sparse-checkout reapply
else
    bl_log "Lade WebKit $WEBKIT_TAG (${WEBKIT_COMMIT:0:12}), shallow"
    attempt=1
    delay=2
    until git -C "$BL_WEBKIT_DIR" fetch -q --depth 1 --filter=blob:none origin "$WEBKIT_COMMIT"; do
        [ "$attempt" -ge 5 ] && bl_die "git fetch ist $attempt mal fehlgeschlagen"
        bl_log "fetch fehlgeschlagen, neuer Versuch in ${delay}s"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
    git -C "$BL_WEBKIT_DIR" -c advice.detachedHead=false checkout -q -f FETCH_HEAD
fi

actual="$(git -C "$BL_WEBKIT_DIR" rev-parse HEAD)"
[ "$actual" = "$WEBKIT_COMMIT" ] || bl_die "Falscher Commit: $actual statt $WEBKIT_COMMIT"
bl_log "Fertig: $(du -sh "$BL_WEBKIT_DIR" --exclude=.git | cut -f1) Quellcode in $BL_WEBKIT_DIR"
