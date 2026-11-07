# shellcheck shell=bash
# libavif: AVIF images (WebKit's AVIFImageDecoder), decoding only, with dav1d
build() {
    dep_cmake "$SRC" \
        -DAVIF_CODEC_DAV1D=SYSTEM \
        -DAVIF_CODEC_AOM=OFF \
        -DAVIF_LIBYUV=OFF \
        -DAVIF_LIBSHARPYUV=OFF \
        -DAVIF_LIBXML2=OFF \
        -DAVIF_JPEG=OFF \
        -DAVIF_ZLIBPNG=OFF \
        -DAVIF_BUILD_APPS=OFF \
        -DAVIF_BUILD_TESTS=OFF \
        -DAVIF_BUILD_EXAMPLES=OFF
}
