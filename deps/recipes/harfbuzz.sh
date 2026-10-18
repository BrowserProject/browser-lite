# shellcheck shell=bash
# HarfBuzz: text shaping (WebKit needs the ICU integration)
build() {
    dep_meson "$SRC" \
        -Dicu=enabled \
        -Dfreetype=enabled \
        -Dglib=disabled \
        -Dgobject=disabled \
        -Dcairo=disabled \
        -Dchafa=disabled \
        -Dpng=disabled \
        -Dzlib=disabled \
        -Draster=disabled \
        -Dvector=disabled \
        -Dgpu=disabled \
        -Dgpu_demo=disabled \
        -Dsubset=disabled \
        -Dtests=disabled \
        -Dintrospection=disabled \
        -Ddocs=disabled \
        -Dutilities=disabled \
        -Dbenchmark=disabled
}
