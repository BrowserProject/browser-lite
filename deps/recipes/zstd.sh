# shellcheck shell=bash
# zstd: Content-Encoding zstd (curl)
build() {
    dep_cmake "$SRC/build/cmake" \
        -DZSTD_BUILD_PROGRAMS=OFF \
        -DZSTD_BUILD_TESTS=OFF \
        -DZSTD_BUILD_SHARED=OFF \
        -DZSTD_BUILD_STATIC=ON \
        -DZSTD_MULTITHREAD_SUPPORT=OFF \
        -DZSTD_LEGACY_SUPPORT=OFF
}
