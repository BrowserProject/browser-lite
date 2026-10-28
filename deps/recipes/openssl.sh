# shellcheck shell=bash
# OpenSSL: TLS in WASM. The WebCore curl backend uses the OpenSSL API directly.
# zlib: certificate compression (TLS extension compress_certificate, like Safari).
# enable-weak-ssl-ciphers: the three 3DES suites Safari offers last (the engine's cipher list).
build() {
    local out="$BL_DEPS_BUILD/$DEP_NAME/build"
    mkdir -p "$out"
    (
        cd "$out" || exit 1
        # Fixed "built on" date in buildinf.h, otherwise every build differs
        export SOURCE_DATE_EPOCH=0
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
            zlib --with-zlib-include="$BL_SYSROOT/include" --with-zlib-lib="$BL_SYSROOT/lib" \
            enable-weak-ssl-ciphers \
            -DOPENSSL_NO_SECURE_MEMORY \
            $BL_CFLAGS
        emmake make -j "$BL_JOBS" build_libs
        emmake make install_dev
    )
}
