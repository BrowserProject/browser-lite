# shellcheck shell=bash
# expat: XML-Parser fuer fontconfig
build() {
    dep_cmake "$SRC" \
        -DEXPAT_BUILD_TOOLS=OFF \
        -DEXPAT_BUILD_EXAMPLES=OFF \
        -DEXPAT_BUILD_TESTS=OFF \
        -DEXPAT_BUILD_DOCS=OFF \
        -DEXPAT_BUILD_FUZZERS=OFF \
        -DEXPAT_SHARED_LIBS=OFF
}
