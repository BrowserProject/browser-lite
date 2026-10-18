#!/usr/bin/env bash
# Rewrites the pkg-config files in the sysroot to the path where the sysroot
# now lives (the CI container builds under /__w/..., the builds run under /src).
# Paths stay absolute so the compiler flags (and thus ccache) do not change.
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
[ "${#files[@]}" -gt 0 ] || bl_die "no .pc files in $sysroot"

# Read the old path from a prefix= line (all libs share the same prefix)
old="$(sed -n 's/^prefix=\(\/.*\)$/\1/p' "${files[@]}" | head -n 1 || true)"
[ -n "$old" ] || bl_die "no prefix= line found"
if [ "$old" = "$sysroot" ]; then
    exit 0
fi
sed -i "s|$old|$sysroot|g" "${files[@]}"
bl_log "pkg-config: $old -> $sysroot (${#files[@]} files)"
