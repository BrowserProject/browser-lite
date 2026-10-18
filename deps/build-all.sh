#!/usr/bin/env bash
# Builds all dependencies for WASM into sysroot/.
#
#   deps/build-all.sh            # everything that changed
#   deps/build-all.sh --force    # rebuild everything
#   deps/build-all.sh --only icu # one lib only (ignores stamps)
#
# Each lib has a stamp (hash of source, recipe, the recipe's DEP_FILES, patches,
# helpers, compiler and the stamp of the previous lib). When anything changes,
# everything from that lib onwards is rebuilt.
set -euo pipefail
# shellcheck source=deps/lib.sh
source "$(dirname "$0")/lib.sh"

# Order matters: later libs depend on earlier ones.
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
        [ $# -ge 2 ] || bl_die "--only needs the name of a lib"
        only="$2"
        shift
        ;;
    *) bl_die "Unknown option: $1" ;;
    esac
    shift
done

command -v emcc >/dev/null || bl_die "emcc missing (run inside the toolchain image)"
mkdir -p "$BL_SYSROOT/.stamps" "$BL_DEPS_BUILD"

compiler_id="$(emcc -dumpversion) $BL_CFLAGS $BL_LDFLAGS"
helpers_hash="$(cat "$BL_DEPS_DIR/lib.sh" "$BL_DEPS_DIR/build-all.sh" | sha256sum | cut -c1-16)"
prev=""

for name in "${ORDER[@]}"; do
    recipe="$BL_DEPS_DIR/recipes/$name.sh"
    [ -f "$recipe" ] || bl_die "Recipe missing: $recipe"
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
        bl_log "$name $(dep_version "$name"): up to date"
        continue
    fi

    bl_log "$name $(dep_version "$name"): building"
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
    # Drop sources and build folder to save space (CI runners have little)
    rm -rf "${BL_DEPS_BUILD:?}/$name"
    bl_log "$name: done in $(( $(date +%s) - start ))s"
done

bl_log "sysroot: $(find "$BL_SYSROOT/lib" -name '*.a' | wc -l) static libs in $BL_SYSROOT"
