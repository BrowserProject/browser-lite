#!/usr/bin/env bash
# Shared settings of the perf scripts, loaded with `source`. They run on the host of a measurement
# (a CI runner or a local machine with Docker) and mount the repository into the containers as /w.
# shellcheck disable=SC2034 # used by the scripts that source this file
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF="$ROOT/tests/perf"
# Archives, test CA, built site and results (inside the repository, so containers see it as /w/...)
OUT="${PERF_OUT:-$ROOT/build/perf}"
# shellcheck source=../../versions.env
source "$ROOT/versions.env"

NET_LINK=bl-perf-link     # device <-> server, shaped with netem
NET_ORIGIN=bl-perf-origin # server <-> replay server and DNS
SERVER_IP=10.77.1.2
DEVICE_IP=10.77.1.3
SERVER_IP2=10.77.2.2
WPR_IP=10.77.2.10
DNS_IP=10.77.2.11

# Cores of the device (first ones taken per profile), the server and the origin side. Defaults fit
# a CI runner with 4 vCPUs.
DEVICE_CPUS="${PERF_DEVICE_CPUS:-0 1}"
SERVER_CPUS="${PERF_SERVER_CPUS:-2}"
ORIGIN_CPUS="${PERF_ORIGIN_CPUS:-3}"

perf_die() {
    echo "perf: $*" >&2
    exit 1
}

# Built sites to measure: $OUT/site-0, site-1, ... (tools/package-demo.sh, one per engine). The
# server delivers site n on port SITE_PORT + n, each under its own origin.
SITE_PORT=8080
perf_sites() {
    local n=0
    while [ -d "$OUT/site-$n/engine" ]; do
        echo "site-$n"
        n=$((n + 1))
    done
}

# cgroup folder of a running container on the host (cgroup v2, systemd or cgroupfs driver)
container_cgroup() {
    local id dir
    id=$(docker inspect -f '{{.Id}}' "$1" 2>/dev/null) || return 1
    for dir in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
        [ -d "$dir" ] && { echo "$dir"; return 0; }
    done
    return 1
}

# Device profile: number of cores and slowdown factor of each core (stealer.mjs)
#   S fast 2 cores, L older laptop, C cheap Chromebook, S4 fast 4 cores, A old Android (6 cores)
profile_cores() {
    case "$1" in
        S | L | C) echo 2 ;;
        S4) echo 4 ;;
        A) echo 6 ;;
        *) perf_die "unknown profile $1" ;;
    esac
}
profile_factor() {
    case "$1" in
        S | S4) echo 1 ;;
        L) echo 1.5 ;;
        C) echo 3 ;;
        A) echo 6 ;;
        *) perf_die "unknown profile $1" ;;
    esac
}
