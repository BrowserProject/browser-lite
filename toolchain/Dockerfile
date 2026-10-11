# Toolchain fuer browser-lite: alles was man braucht um WebKit + Dependencies
# mit Emscripten nach WebAssembly zu bauen. Lokal und in CI das gleiche Image.
#
# Bauen:  docker build -t browser-lite-toolchain --build-arg EMSDK_VERSION=6.0.10 toolchain/
# (CI liest EMSDK_VERSION aus versions.env)

# Basis-Image ueberschreibbar, z.B. mit einem Mirror falls Docker Hub limitiert:
#   --build-arg BASE_IMAGE=mirror.gcr.io/library/ubuntu:24.04
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG EMSDK_VERSION
ARG DEBIAN_FRONTEND=noninteractive

RUN test -n "$EMSDK_VERSION" || (echo "EMSDK_VERSION fehlt" && exit 1)

# Host-Tools fuer WebKit (cmake, ninja, perl, python, ruby, gperf, unifdef)
# und fuer die Dependencies (autotools, meson, pkg-config).
RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        bzip2 \
        ca-certificates \
        ccache \
        cmake \
        curl \
        file \
        g++ \
        gcc \
        git \
        gperf \
        libtool \
        make \
        meson \
        ninja-build \
        patch \
        perl \
        pkg-config \
        python3 \
        python3-pip \
        ruby \
        unifdef \
        unzip \
        xz-utils \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# Emscripten SDK, fix gepinnt
ENV EMSDK=/opt/emsdk
RUN git clone --depth 1 --branch "$EMSDK_VERSION" https://github.com/emscripten-core/emsdk.git "$EMSDK" \
    && cd "$EMSDK" \
    && ./emsdk install "$EMSDK_VERSION" \
    && ./emsdk activate "$EMSDK_VERSION" \
    && rm -rf "$EMSDK/downloads" \
    && ln -s "$(ls -d "$EMSDK"/node/*/bin)/node" /usr/local/bin/node \
    && ln -s "$(ls -d "$EMSDK"/node/*/bin)/npm" /usr/local/bin/npm

ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/upstream/bin:${PATH}" \
    EM_CONFIG=/opt/emsdk/.emscripten \
    EM_CACHE=/opt/emsdk/upstream/emscripten/cache \
    CCACHE_DIR=/ccache

# System-Libs von Emscripten schon vorbauen (normal und mit pthreads), damit das
# nicht bei jedem CI-Lauf passiert. Dafuer einfach ein kleines Programm in beiden
# Varianten bauen, dann landet genau das im Cache was wir brauchen.
# Danach Cache fuer alle beschreibbar machen (CI-Jobs evtl. mit anderer UID).
COPY warm.cpp /tmp/warm.cpp
RUN true \
    && em++ -O2 /tmp/warm.cpp -o /tmp/warm.js \
    && em++ -O2 -pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME /tmp/warm.cpp -o /tmp/warm-mt.js \
    && node /tmp/warm-mt.js \
    && rm -f /tmp/warm* \
    && chmod -R a+rwX "$EM_CACHE"

RUN emcc --version && node --version && cmake --version && ninja --version

WORKDIR /src
