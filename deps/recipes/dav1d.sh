# shellcheck shell=bash
# dav1d: AV1 decoder of libavif (AVIF images). No assembly for WASM; libavif runs it with one
# thread, so it starts no threads of its own.
build() {
    dep_meson "$SRC" \
        -Denable_asm=false \
        -Denable_tools=false \
        -Denable_examples=false \
        -Denable_tests=false \
        -Denable_docs=false
}
