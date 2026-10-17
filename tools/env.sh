#!/usr/bin/env bash
# Gemeinsame Pfade und Versionen fuer alle Skripte. Wird mit `source` geladen.

BL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BL_ROOT

set -a
# shellcheck source=versions.env
source "$BL_ROOT/versions.env"
set +a

export BL_THIRD_PARTY="${BL_THIRD_PARTY:-$BL_ROOT/third_party}"
export BL_WEBKIT_DIR="${BL_WEBKIT_DIR:-$BL_THIRD_PARTY/WebKit}"
export BL_BUILD_DIR="${BL_BUILD_DIR:-$BL_ROOT/build}"
export BL_SYSROOT="${BL_SYSROOT:-$BL_ROOT/sysroot}"

bl_log() {
    printf '==> %s\n' "$*"
}

bl_die() {
    printf 'FEHLER: %s\n' "$*" >&2
    exit 1
}

# Befehl bis zu 5 mal versuchen (Netz), Pause 2, 4, 8, 16 s
bl_retry() {
    local attempt=1 delay=2
    until "$@"; do
        [ "$attempt" -ge 5 ] && bl_die "$* ist $attempt mal fehlgeschlagen"
        bl_log "fehlgeschlagen, neuer Versuch in ${delay}s"
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}
