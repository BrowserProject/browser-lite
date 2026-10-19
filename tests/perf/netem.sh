#!/usr/bin/env bash
# Network profile of the link between device and server (netem on both ends, half the delay each).
# Runs on the host after server.sh and with perf-device running.
#   lan, dc (30 ms, data center), mobile (80 ms), poor (150 ms, 1 % loss); to separate latency and
#   bandwidth: rtt80 (80 ms, no limit) and rate20 (20/5 Mbit, no delay)
#
#   tests/perf/netem.sh <profile>
set -euo pipefail
profile="${1:?profile}"
case "$profile" in
    lan) delay=0 jitter=0 loss=0 down=0 up=0 ;;
    dc) delay=15 jitter=1 loss=0 down=50 up=20 ;;
    mobile) delay=40 jitter=5 loss=0.1 down=20 up=5 ;;
    poor) delay=75 jitter=15 loss=1 down=5 up=1 ;;
    rtt80) delay=40 jitter=5 loss=0 down=1000 up=1000 ;;
    rate20) delay=0.1 jitter=0 loss=0 down=20 up=5 ;;
    *) echo "unknown network profile $profile" >&2; exit 2 ;;
esac
shape() { # <container> <device> <rate in Mbit>; a container that does not run is left out
    local pid
    pid=$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null) || return 0
    [ "$pid" != 0 ] || return 0
    if [ "$delay" = 0 ]; then
        nsenter -t "$pid" -n tc qdisc del dev "$2" root 2>/dev/null || true
        return
    fi
    local args=(delay "${delay}ms")
    if [ "$jitter" != 0 ]; then args+=("${jitter}ms" distribution normal); fi
    args+=(loss "${loss}%" rate "${3}mbit" limit 10000)
    nsenter -t "$pid" -n tc qdisc replace dev "$2" root netem "${args[@]}"
}
if server_dev=$(docker exec perf-server sh -c "ip -o -4 addr show | awk '/10\\.77\\.1\\./{print \$2}'" 2>/dev/null); then
    shape perf-server "$server_dev" "$down"
fi
shape perf-device eth0 "$up"
