#!/usr/bin/env bash
# Prepares a host for perf measurements (repeatable, keeps what exists): Docker networks, the image
# of the core stealer, Web Page Replay built at PERF_WPR_COMMIT, a test CA for the replay server, the
# test video and, with "wpe", the image with native WPE WebKit.
#
#   tests/perf/setup.sh [wpe]
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"

mkdir -p "$OUT/wpr" "$OUT/results"

docker network inspect "$NET_LINK" >/dev/null 2>&1 ||
    docker network create --internal --subnet 10.77.1.0/24 "$NET_LINK" >/dev/null
docker network inspect "$NET_ORIGIN" >/dev/null 2>&1 ||
    docker network create --internal --subnet 10.77.2.0/24 "$NET_ORIGIN" >/dev/null

docker image inspect bl-perf-stealer >/dev/null 2>&1 ||
    docker build -q --build-arg NODE_IMAGE="$NODE_IMAGE" -t bl-perf-stealer "$PERF/docker/stealer" >/dev/null

if [ ! -x "$OUT/wpr/wpr" ]; then
    docker run --rm -v "$OUT/wpr:/out" -e CGO_ENABLED=0 "$PERF_GO_IMAGE" sh -c "
        set -e
        apk add -q git >/dev/null
        git clone -q $PERF_WPR_REPO /src
        cd /src
        git checkout -q $PERF_WPR_COMMIT
        go build -o /out/wpr ./src/wpr.go
        cp deterministic.js /out/"
fi

# Own test CA: the RSA root of Web Page Replay has only 1024 bits, which the engine (OpenSSL
# security level 2) rightly refuses
if [ ! -f "$OUT/wpr/ca.pem" ]; then
    (
        cd "$OUT/wpr"
        openssl req -x509 -newkey rsa:2048 -nodes -keyout rsa_key.pem -out rsa_cert.pem -days 30 \
            -subj "/CN=browser-lite perf RSA test CA" -addext "basicConstraints=critical,CA:TRUE" \
            -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ec_key.pem \
            -out ec_cert.pem -days 30 -subj "/CN=browser-lite perf ECDSA test CA" \
            -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
        cat rsa_cert.pem ec_cert.pem >ca.pem
    )
fi

# The video of video.mjs, for the device's own Chromium (the device has no internet)
if [ ! -f "$OUT/video.webm" ]; then
    curl -fsSL "$PERF_VIDEO_URL" -o "$OUT/video.webm.part"
    echo "$PERF_VIDEO_SHA256  $OUT/video.webm.part" | sha256sum -c --quiet
    mv "$OUT/video.webm.part" "$OUT/video.webm"
fi

if [ "${1:-}" = wpe ] && ! docker image inspect bl-perf-wpe >/dev/null 2>&1; then
    cp "$OUT/wpr/ca.pem" "$PERF/docker/wpe/perf-ca.crt"
    docker build -q --build-arg DEBIAN_IMAGE="$PERF_DEBIAN_IMAGE" --build-arg SNAPSHOT="$PERF_DEBIAN_SNAPSHOT" \
        -t bl-perf-wpe "$PERF/docker/wpe" >/dev/null
    rm -f "$PERF/docker/wpe/perf-ca.crt"
fi
echo "perf setup ready in $OUT"
