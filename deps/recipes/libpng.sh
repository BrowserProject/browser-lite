# shellcheck shell=bash
# libpng: PNG-Bilder
build() {
    dep_cmake "$SRC" \
        -DPNG_SHARED=OFF \
        -DPNG_STATIC=ON \
        -DPNG_TESTS=OFF \
        -DPNG_TOOLS=OFF \
        -DPNG_FRAMEWORK=OFF \
        -DPNG_HARDWARE_OPTIMIZATIONS=OFF
}
