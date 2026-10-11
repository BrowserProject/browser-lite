# shellcheck shell=bash
# FreeType: Font-Rasterung (Skia, fontconfig, harfbuzz)
build() {
    dep_cmake "$SRC" \
        -DFT_REQUIRE_ZLIB=ON \
        -DFT_REQUIRE_PNG=ON \
        -DFT_DISABLE_BZIP2=ON \
        -DFT_DISABLE_HARFBUZZ=ON \
        -DFT_DISABLE_BROTLI=ON
}
