#!/usr/bin/env bash
# Builds the toolchain image locally with the pins of versions.env (the CI passes
# the same values to docker/build-push-action).
#
#   tools/build-toolchain.sh [tag]     # default: browser-lite-toolchain
#   BASE_IMAGE=mirror.gcr.io/library/ubuntu:24.04@sha256:... tools/build-toolchain.sh
#                                      # same base image from a mirror
set -euo pipefail
# shellcheck source=tools/env.sh
source "$(dirname "$0")/env.sh"

docker build -t "${1:-browser-lite-toolchain}" \
    --build-arg BASE_IMAGE="${BASE_IMAGE:-$TOOLCHAIN_BASE_IMAGE}" \
    --build-arg EMSDK_VERSION="$EMSDK_VERSION" \
    --build-arg EMSDK_COMMIT="$EMSDK_COMMIT" \
    --build-arg MESON_VERSION="$MESON_VERSION" \
    --build-arg MESON_SHA256="$MESON_SHA256" \
    "$BL_ROOT/toolchain"
