# shellcheck shell=bash
# libpsl: Public Suffix List (Cookies, curl). Liste wird fest eingebaut.
build() {
    dep_meson "$SRC" \
        -Druntime=no \
        -Dbuiltin=true \
        -Dtests=false \
        -Ddocs=false
}
