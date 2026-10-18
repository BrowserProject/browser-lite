# shellcheck shell=bash
# libpsl: Public Suffix List (cookies, curl). The list is built in.
build() {
    dep_meson "$SRC" \
        -Druntime=no \
        -Dbuiltin=true \
        -Dtests=false \
        -Ddocs=false
}
