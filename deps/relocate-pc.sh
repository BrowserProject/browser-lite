#!/usr/bin/env bash
# Passt die pkg-config-Dateien im sysroot an den Pfad an, in dem das sysroot
# jetzt liegt (CI-Container baut unter /__w/..., die Builds laufen unter /src).
# Absolute Pfade bleiben absolut, damit sich die Compiler-Flags (und damit
# der ccache) nicht aendern.
#
#   deps/relocate-pc.sh [sysroot]
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/../tools/env.sh"

sysroot="$(cd "${1:-$BL_SYSROOT}" && pwd)"
files=()
for dir in "$sysroot/lib/pkgconfig" "$sysroot/share/pkgconfig"; do
    [ -d "$dir" ] && files+=("$dir"/*.pc)
done
[ "${#files[@]}" -gt 0 ] || bl_die "keine .pc-Dateien in $sysroot"

# Alten Pfad aus einer prefix=-Zeile lesen (alle Libs haben dasselbe Prefix)
old="$(sed -n 's/^prefix=\(\/.*\)$/\1/p' "${files[@]}" | head -n 1 || true)"
[ -n "$old" ] || bl_die "keine prefix=-Zeile gefunden"
if [ "$old" = "$sysroot" ]; then
    exit 0
fi
sed -i "s|$old|$sysroot|g" "${files[@]}"
bl_log "pkg-config: $old -> $sysroot (${#files[@]} Dateien)"
