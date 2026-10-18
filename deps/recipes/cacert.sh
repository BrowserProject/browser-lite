# shellcheck shell=bash
# CA certificates (Mozilla, via curl.se) for TLS in WASM
build() {
    local dest="$BL_SYSROOT/runtime/etc/ssl/certs"
    mkdir -p "$dest"
    cp "$SRC"/cacert-*.pem "$dest/ca-certificates.crt"
}
