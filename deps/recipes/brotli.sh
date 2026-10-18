# shellcheck shell=bash
# brotli: Content-Encoding br (curl) and WOFF2 fonts
build() {
    dep_cmake "$SRC" -DBROTLI_DISABLE_TESTS=ON -DBROTLI_BUILD_TOOLS=OFF
}
