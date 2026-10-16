#!/usr/bin/env bash
# Baut alle Dependencies nach WASM ins sysroot/.
#
#   deps/build-all.sh            # alles was sich geaendert hat
#   deps/build-all.sh --force    # alles neu
#   deps/build-all.sh --only icu # nur eine Lib (ignoriert Stamps)
#
# Jede Lib hat einen Stamp (Hash aus Quelle, Rezept, den Dateien in DEP_FILES des
# Rezepts, Patches, Helfern, Compiler und dem Stamp der vorherigen Lib). Aendert
# sich etwas, wird ab dieser Lib neu gebaut.
set -euo pipefail
# shellcheck source=deps/lib.sh
source "$(dirname "$0")/lib.sh"

# Reihenfolge ist wichtig: spaetere Libs brauchen fruehere.
ORDER=(
    zlib
    brotli
    zstd
    libpng
    libjpeg-turbo
    libwebp
    expat
    libxml2
    libxslt
    sqlite
    icu
    freetype
    harfbuzz
    fontconfig
    woff2
    libpsl
    openssl
    nghttp2
    curl
    notosans
    notoserif
    notosansmono
    cacert
    fontconfig-conf
    fontcache
)

force=0
only=""
while [ $# -gt 0 ]; do
    case "$1" in
    --force) force=1 ;;
    --only)
        [ $# -ge 2 ] || bl_die "--only braucht den Namen einer Lib"
        only="$2"
        shift
        ;;
    *) bl_die "Unbekannte Option: $1" ;;
    esac
    shift
done

command -v emcc >/dev/null || bl_die "emcc fehlt (im Toolchain-Image ausfuehren)"
mkdir -p "$BL_SYSROOT/.stamps" "$BL_DEPS_BUILD"

compiler_id="$(emcc -dumpversion) $BL_CFLAGS $BL_LDFLAGS"
helpers_hash="$(cat "$BL_DEPS_DIR/lib.sh" "$BL_DEPS_DIR/build-all.sh" | sha256sum | cut -c1-16)"
prev=""

for name in "${ORDER[@]}"; do
    recipe="$BL_DEPS_DIR/recipes/$name.sh"
    [ -f "$recipe" ] || bl_die "Rezept fehlt: $recipe"
    patches_hash="$( { cat "$BL_DEPS_DIR/patches/$name"/*.patch 2>/dev/null || true; } | sha256sum | cut -c1-16)"
    # shellcheck disable=SC1090
    files_hash="$( (DEP_FILES=(); source "$recipe"; for f in "${DEP_FILES[@]}"; do cat "$BL_DEPS_DIR/$f"; done) | sha256sum | cut -c1-16)"
    stamp="$( { dep_source_line "$name"; cat "$recipe"; echo "$compiler_id $helpers_hash $patches_hash $files_hash $prev"; } | sha256sum | cut -c1-32)"
    prev="$stamp"
    stamp_file="$BL_SYSROOT/.stamps/$name"

    if [ -n "$only" ] && [ "$only" != "$name" ]; then
        continue
    fi
    if [ "$force" = 0 ] && [ -z "$only" ] && [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$stamp" ]; then
        bl_log "$name $(dep_version "$name"): aktuell"
        continue
    fi

    bl_log "$name $(dep_version "$name"): baue"
    start=$(date +%s)
    rm -f "$stamp_file"
    dep_fetch "$name"
    (
        export DEP_NAME="$name"
        export SRC="$BL_DEPS_BUILD/$name/src"
        # shellcheck disable=SC1090
        source "$recipe"
        build
    )
    echo "$stamp" > "$stamp_file"
    # Quellen und Build-Ordner wegwerfen, spart Platz (CI-Runner haben wenig)
    rm -rf "${BL_DEPS_BUILD:?}/$name"
    bl_log "$name: fertig in $(( $(date +%s) - start ))s"
done

bl_log "sysroot: $(find "$BL_SYSROOT/lib" -name '*.a' | wc -l) statische Libs in $BL_SYSROOT"
