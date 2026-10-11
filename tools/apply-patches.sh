#!/usr/bin/env bash
# Setzt den WebKit-Checkout auf den gepinnten Commit zurueck und wendet alle
# Patches aus patches/webkit/ der Reihe nach an (Sortierung nach Dateiname).
#
#   tools/apply-patches.sh          # zuruecksetzen + anwenden
#   tools/apply-patches.sh --check  # nur pruefen, ob alles sauber anwendbar ist
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

mode="apply"
[ "${1:-}" = "--check" ] && mode="check"

[ -d "$BL_WEBKIT_DIR/.git" ] || bl_die "Kein WebKit-Checkout. Zuerst tools/fetch-webkit.sh ausfuehren."

bl_log "Setze WebKit auf ${WEBKIT_COMMIT:0:12} zurueck"
git -C "$BL_WEBKIT_DIR" reset -q --hard "$WEBKIT_COMMIT"
git -C "$BL_WEBKIT_DIR" clean -q -fd

shopt -s nullglob
patches=("$BL_ROOT"/patches/webkit/*.patch)
if [ "${#patches[@]}" -eq 0 ]; then
    bl_log "Keine Patches vorhanden, nichts zu tun"
    exit 0
fi

for p in "${patches[@]}"; do
    name="$(basename "$p")"
    git -C "$BL_WEBKIT_DIR" apply --check "$p" || bl_die "Patch passt nicht: $name"
    if [ "$mode" = "apply" ]; then
        git -C "$BL_WEBKIT_DIR" apply "$p"
        bl_log "angewendet: $name"
    else
        # Fuer --check muessen spaetere Patches auf den frueheren aufbauen koennen.
        git -C "$BL_WEBKIT_DIR" apply "$p"
        bl_log "ok: $name"
    fi
done

if [ "$mode" = "check" ]; then
    git -C "$BL_WEBKIT_DIR" reset -q --hard "$WEBKIT_COMMIT"
    git -C "$BL_WEBKIT_DIR" clean -q -fd
else
    # Stand nach allen Patches ins Index legen, damit tools/export-patch.sh
    # spaeter nur neue Aenderungen exportiert.
    git -C "$BL_WEBKIT_DIR" add -A
fi
bl_log "${#patches[@]} Patch(es) ok"
