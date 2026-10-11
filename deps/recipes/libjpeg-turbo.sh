# shellcheck shell=bash
# libjpeg-turbo: JPEG-Bilder (ohne SIMD-Assembler, gibt es fuer WASM nicht)
build() {
    dep_cmake "$SRC" \
        -DENABLE_SHARED=OFF \
        -DENABLE_STATIC=ON \
        -DWITH_SIMD=OFF \
        -DWITH_TURBOJPEG=OFF \
        -DWITH_TOOLS=OFF \
        -DWITH_TESTS=OFF
}
