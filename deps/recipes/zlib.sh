# shellcheck shell=bash
# zlib: compression (for libpng, freetype, curl, ...)
build() {
    dep_cmake "$SRC" -DZLIB_BUILD_EXAMPLES=OFF
    # zlib always installs a "shared" variant too, which is not wanted.
    rm -f "$BL_SYSROOT"/lib/libz.so* "$BL_SYSROOT"/lib/libz.js "$BL_SYSROOT"/lib/libz.wasm
}
