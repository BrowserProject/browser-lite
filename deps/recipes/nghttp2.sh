# shellcheck shell=bash
# nghttp2: HTTP/2 fuer curl
build() {
    dep_cmake "$SRC" \
        -DENABLE_LIB_ONLY=ON \
        -DBUILD_STATIC_LIBS=ON \
        -DENABLE_DOC=OFF \
        -DBUILD_TESTING=OFF
}
