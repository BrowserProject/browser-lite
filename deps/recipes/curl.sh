# shellcheck shell=bash
# libcurl: HTTP(S), HTTP/2, WebSockets for the WebCore curl backend.
# Sockets go through the engine's socket layer (engine/src/Sockets.cpp, --wrap).
build() {
    dep_cmake "$SRC" \
        -DBUILD_CURL_EXE=OFF \
        -DBUILD_LIBCURL_DOCS=OFF \
        -DBUILD_MISC_DOCS=OFF \
        -DBUILD_TESTING=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DENABLE_CURL_MANUAL=OFF \
        -DCURL_USE_OPENSSL=ON \
        -DUSE_NGHTTP2=ON \
        -DCURL_BROTLI=ON \
        -DCURL_ZSTD=ON \
        -DCURL_ZLIB=ON \
        -DCURL_USE_LIBPSL=ON \
        -DCURL_USE_LIBSSH2=OFF \
        -DCURL_USE_LIBSSH=OFF \
        -DCURL_USE_GSSAPI=OFF \
        -DUSE_LIBIDN2=OFF \
        -DUSE_LIBRTMP=OFF \
        -DENABLE_THREADED_RESOLVER=OFF \
        -DENABLE_ARES=OFF \
        -DENABLE_UNIX_SOCKETS=OFF \
        -DCURL_DISABLE_LDAP=ON \
        -DCURL_DISABLE_LDAPS=ON \
        -DCURL_DISABLE_FTP=ON \
        -DCURL_DISABLE_DICT=ON \
        -DCURL_DISABLE_GOPHER=ON \
        -DCURL_DISABLE_IMAP=ON \
        -DCURL_DISABLE_MQTT=ON \
        -DCURL_DISABLE_POP3=ON \
        -DCURL_DISABLE_RTSP=ON \
        -DCURL_DISABLE_SMB=ON \
        -DCURL_DISABLE_SMTP=ON \
        -DCURL_DISABLE_TELNET=ON \
        -DCURL_DISABLE_TFTP=ON \
        -DCURL_CA_BUNDLE=none \
        -DCURL_CA_PATH=none \
        -DCURL_CA_FALLBACK=OFF
}
