# shellcheck shell=bash
# woff2: decodes WOFF2 web fonts (WebKit USE_WOFF2)
build() {
    # The woff2 tools (woff2_decompress, ...) link brotlidec without brotlicommon,
    # so pass brotlicommon to all programs.
    dep_cmake "$SRC" -DCANONICAL_PREFIXES=ON \
        -DCMAKE_EXE_LINKER_FLAGS="$BL_LDFLAGS -L$BL_SYSROOT/lib -lbrotlicommon"
}
