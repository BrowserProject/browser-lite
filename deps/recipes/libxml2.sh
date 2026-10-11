# shellcheck shell=bash
# libxml2: XML/XHTML/SVG-Parser von WebCore
build() {
    dep_cmake "$SRC" \
        -DLIBXML2_WITH_PYTHON=OFF \
        -DLIBXML2_WITH_PROGRAMS=OFF \
        -DLIBXML2_WITH_TESTS=OFF \
        -DLIBXML2_WITH_LZMA=OFF \
        -DLIBXML2_WITH_ZLIB=OFF \
        -DLIBXML2_WITH_ICU=OFF \
        -DLIBXML2_WITH_ICONV=OFF \
        -DLIBXML2_WITH_HTTP=OFF \
        -DLIBXML2_WITH_MODULES=OFF \
        -DLIBXML2_WITH_DOCS=OFF \
        -DLIBXML2_WITH_THREADS=ON
}
