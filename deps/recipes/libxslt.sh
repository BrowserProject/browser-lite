# shellcheck shell=bash
# libxslt: XSLT for WebCore
build() {
    dep_cmake "$SRC" \
        -DLIBXSLT_WITH_PYTHON=OFF \
        -DLIBXSLT_WITH_PROGRAMS=OFF \
        -DLIBXSLT_WITH_TESTS=OFF \
        -DLIBXSLT_WITH_CRYPTO=OFF \
        -DLIBXSLT_WITH_MODULES=OFF \
        -DLIBXSLT_WITH_PROFILER=OFF
}
