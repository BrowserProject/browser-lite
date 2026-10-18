# shellcheck shell=bash
# OpenSSL: TLS in WASM. The WebCore curl backend uses the OpenSSL API directly.
build() {
    local out="$BL_DEPS_BUILD/$DEP_NAME/build"
    mkdir -p "$out"
    (
        cd "$out" || exit 1
        # linux-generic32 = 32-bit without assembly, fits wasm32
        # shellcheck disable=SC2086
        CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
            perl "$SRC/Configure" linux-generic32 \
            --prefix="$BL_SYSROOT" \
            --libdir=lib \
            --openssldir=/etc/ssl \
            no-asm no-shared no-dso no-engine no-afalgeng no-async \
            no-tests no-apps no-docs no-secure-memory no-ui-console \
            no-quic \
            -DOPENSSL_NO_SECURE_MEMORY \
            $BL_CFLAGS
        emmake make -j "$BL_JOBS" build_libs
        emmake make install_dev
    )
}
