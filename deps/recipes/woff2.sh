# shellcheck shell=bash
# woff2: WOFF2-Webfonts entpacken (WebKit USE_WOFF2)
build() {
    # Die woff2-Tools (woff2_decompress, ...) linken brotlidec ohne brotlicommon,
    # darum brotlicommon fuer alle Programme mitgeben.
    dep_cmake "$SRC" -DCANONICAL_PREFIXES=ON \
        -DCMAKE_EXE_LINKER_FLAGS="$BL_LDFLAGS -L$BL_SYSROOT/lib -lbrotlicommon"
}
