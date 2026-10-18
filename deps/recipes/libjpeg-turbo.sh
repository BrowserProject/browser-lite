# shellcheck shell=bash
# libjpeg-turbo: JPEG images (without SIMD assembly, not available for WASM)
build() {
    dep_cmake "$SRC" \
        -DENABLE_SHARED=OFF \
        -DENABLE_STATIC=ON \
        -DWITH_SIMD=OFF \
        -DWITH_TURBOJPEG=OFF \
        -DWITH_TOOLS=OFF \
        -DWITH_TESTS=OFF
}
