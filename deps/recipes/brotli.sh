# shellcheck shell=bash
# brotli: Content-Encoding br (curl) und WOFF2-Fonts
build() {
    dep_cmake "$SRC" -DBROTLI_DISABLE_TESTS=ON -DBROTLI_BUILD_TOOLS=OFF
}
