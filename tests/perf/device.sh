#!/usr/bin/env bash
# Runs a command in the device container with a device profile and a network profile. Runs on the
# host after server.sh. With a factor above 1, a realtime thread on each device core (stealer.mjs)
# takes (F-1)/F of every 2 ms period, so the device gets 1/F of each core regardless of how many
# threads it runs (weighted CPU shares do not do that: they depend on the number of busy threads).
#
#   tests/perf/device.sh <profile> <network> <command...>
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"
profile="${1:?profile}"
network="${2:?network}"
shift 2
count=$(profile_cores "$profile")
factor=$(profile_factor "$profile")
read -r -a all <<<"$DEVICE_CPUS"
[ "${#all[@]}" -ge "$count" ] || perf_die "profile $profile needs $count device cores, PERF_DEVICE_CPUS has ${#all[@]}"
cpus="${all[*]:0:count}"
cpuset=$(tr ' ' ',' <<<"$cpus")
docker rm -f perf-device perf-stealer >/dev/null 2>&1 || true
monitor=
cleanup() {
    if [ -n "$monitor" ]; then kill "$monitor" 2>/dev/null || true; fi
    docker rm -f perf-device perf-stealer >/dev/null 2>&1 || true
}
trap cleanup EXIT
if [ "$factor" != 1 ]; then
    docker run -d --name perf-stealer --network none --cpuset-cpus "$cpuset" --cap-add SYS_NICE --ulimit rtprio=99 \
        -v "$PERF:/p:ro" bl-perf-stealer \
        sh -c "for c in $cpus; do taskset -c \$c chrt -f 50 node /p/stealer.mjs $factor & done; wait" >/dev/null
fi
docker run -d --name perf-device --network "$NET_LINK" --ip "$DEVICE_IP" --cpuset-cpus "$cpuset" \
    --memory "${PERF_DEVICE_MEM:-2500m}" --memory-swap "${PERF_DEVICE_MEM:-2500m}" --shm-size 1g --init \
    -e PERF_PROFILE="$profile" -e PERF_NET="$network" -e PERF_CPUS="$count" -e PERF_FACTOR="$factor" \
    -e SERVER="http://$SERVER_IP:8080" -v "$ROOT:/w" -w /w/tests/perf "$PERF_PLAYWRIGHT_IMAGE" sleep infinity >/dev/null
bash "$PERF/netem.sh" "$network"
bash "$PERF/foreign.sh" "$cpus" "$OUT/results/foreign.log" &
monitor=$!
docker exec perf-device "$@"
