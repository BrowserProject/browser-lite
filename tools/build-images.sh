#!/usr/bin/env bash
# Builds the images of the Dockerfile and tests each one read-only, without capabilities:
#   $SERVER_IMAGE:<revision>  target server: /healthz, relay answers 101, clean exit on SIGTERM
#   $DEMO_IMAGE:<revision>    target demo with <demo-site-dir> (tools/package-demo.sh), also
#                             COEP header, Brotli engine.wasm, /profile/info
# "-" as <demo-site-dir> builds only the server image. Needs the built packages (npm run build).
# BL_CPUSET (for example 6-9) pins the test containers to these CPUs.
#
#   tools/build-images.sh <demo-site-dir|-> <revision>
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

[ "$#" -eq 2 ] || bl_die "usage: tools/build-images.sh <demo-site-dir|-> <revision>"
site="$1"
revision="$2"
[ -f "$BL_ROOT/packages/server/dist/bin/browser-lite-server.js" ] || bl_die "packages not built (npm ci && npm run build)"
if [ "$site" != - ]; then
    compgen -G "$site/engine/*/engine.wasm" >/dev/null || bl_die "$site is no packaged demo (tools/package-demo.sh)"
fi

build() { # <target> <tag> [docker build args...]
    local target="$1" tag="$2"
    shift 2
    bl_log "Building $tag (target $target)"
    docker build --target "$target" -t "$tag" --build-arg NODE_IMAGE="$NODE_IMAGE" \
        --label org.opencontainers.image.source="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-BrowserProject/browser-lite}" \
        --label org.opencontainers.image.revision="$revision" \
        "$@" "$BL_ROOT"
}

smoke() { # <tag> <with-site>
    local tag="$1" with_site="$2" name="bl-smoke-$$" port code
    local args=(--read-only --cap-drop ALL -p 127.0.0.1::8080)
    [ -n "${BL_CPUSET:-}" ] && args+=(--cpuset-cpus "$BL_CPUSET")
    [ "$with_site" = 1 ] && args+=(--tmpfs "/data:uid=1000,gid=1000")
    bl_log "Testing $tag"
    docker run -d --name "$name" "${args[@]}" "$tag" >/dev/null
    # shellcheck disable=SC2064 # expand name now
    trap "docker logs $name; docker rm -f $name >/dev/null" EXIT
    port="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"
    local base="http://127.0.0.1:$port"
    timeout 30 sh -c "until curl -fs $base/healthz >/dev/null; do sleep 1; done" ||
        bl_die "$tag: /healthz does not answer"
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$base/wisp/" || true)"
    [ "$code" = 101 ] || bl_die "$tag: relay answers $code instead of 101 to a WebSocket upgrade"
    if [ "$with_site" = 1 ]; then
        curl -fsI "$base/" | grep -qi '^cross-origin-embedder-policy: require-corp' ||
            bl_die "$tag: no COEP header on /"
        local wasm
        wasm="$(cd "$site" && ls engine/*/engine.wasm)"
        curl -fsI -H 'Accept-Encoding: br' "$base/$wasm" | grep -qi '^content-encoding: br' ||
            bl_die "$tag: $wasm not delivered with Brotli"
        curl -fsS "$base/profile/info" | grep -q '"maxBytes"' || bl_die "$tag: /profile/info does not answer"
    fi
    docker stop -t 5 "$name" >/dev/null
    [ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0 ] ||
        bl_die "$tag: container does not end cleanly on SIGTERM"
    trap - EXIT
    docker rm "$name" >/dev/null
}

build server "$SERVER_IMAGE:$revision" --label org.opencontainers.image.licenses=BSD-2-Clause
smoke "$SERVER_IMAGE:$revision" 0
if [ "$site" != - ]; then
    build demo "$DEMO_IMAGE:$revision" --build-context site="$(realpath "$site")"
    smoke "$DEMO_IMAGE:$revision" 1
fi
bl_log "Images ok"
