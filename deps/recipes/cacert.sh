# shellcheck shell=bash
# CA-Zertifikate (Mozilla, via curl.se) fuer TLS im WASM
build() {
    local dest="$BL_SYSROOT/runtime/etc/ssl/certs"
    mkdir -p "$dest"
    cp "$SRC"/cacert-*.pem "$dest/ca-certificates.crt"
}
