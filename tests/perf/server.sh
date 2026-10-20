#!/usr/bin/env bash
# Server side of a perf measurement: one browser-lite-server per built site ($OUT/site-<n>, one per
# engine) on port SITE_PORT + n, so every engine has its own origin (storage lock, OPFS, HTTP cache
# and service worker would be shared otherwise), and, for record and replay, Web Page Replay with
# a DNS that points every name at it.
#
#   tests/perf/server.sh record <archive>   replay server records from the internet
#   tests/perf/server.sh replay <archive>   replay server plays back, 10 ms away
#   tests/perf/server.sh live               server with internet and real DNS
#   tests/perf/server.sh stop
#
# PERF_TUNE=1: TCP of the server towards the device without slow start after idle and with an
# initial window of 40 (experiment t3g).
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"
mode="${1:?record|replay|live|stop}"
archive="${2:-}"

if docker inspect perf-wpr >/dev/null 2>&1; then
    docker logs perf-wpr >"$OUT/results/wpr-$(date +%Y%m%d-%H%M%S).log" 2>&1 || true
fi
docker rm -f perf-server perf-wpr perf-dns >/dev/null 2>&1 || true
[ "$mode" = stop ] && exit 0
mapfile -t sites < <(perf_sites)
[ "${#sites[@]}" -gt 0 ] || perf_die "no built demo in $OUT/site-0 (tools/package-demo.sh)"
[[ "$OUT" == "$ROOT"/* ]] || perf_die "PERF_OUT must be inside the repository"

server_env=()
server_dns=()
if [ "$mode" = record ] || [ "$mode" = replay ]; then
    [ -n "$archive" ] || perf_die "archive missing"
    mkdir -p "$OUT/archive"
    docker run -d --name perf-dns --network "$NET_ORIGIN" --ip "$DNS_IP" --cpuset-cpus "$ORIGIN_CPUS" \
        -v "$PERF:/p:ro" "$NODE_IMAGE" node /p/dns.mjs "$WPR_IP" >/dev/null
    docker create --name perf-wpr --network "$NET_ORIGIN" --ip "$WPR_IP" --cpuset-cpus "$ORIGIN_CPUS" \
        --cpu-shares 8192 -v "$OUT/wpr:/wpr" -v "$OUT/archive:/archive" -w /wpr "$NODE_IMAGE" \
        /wpr/wpr "$mode" --host 0.0.0.0 --http-port 80 --https-port 443 --https-to-http-port -1 \
        --https-cert-file rsa_cert.pem,ec_cert.pem --https-key-file rsa_key.pem,ec_key.pem \
        --inject-scripts deterministic.js "/archive/$archive" >/dev/null
    # Recording needs the internet (default Docker network on top)
    [ "$mode" = record ] && docker network connect bridge perf-wpr
    docker start perf-wpr >/dev/null
    server_env+=(-e RELAY_ALLOW_LOCAL=1)
    server_dns=(--dns "$DNS_IP")
fi
servers=
for n in "${!sites[@]}"; do
    servers+="PORT=$((SITE_PORT + n)) SITE_DIR=/w/${OUT#"$ROOT"/}/${sites[n]} node packages/server/dist/bin/browser-lite-server.js & "
done
docker create --name perf-server --network "$NET_LINK" --ip "$SERVER_IP" --cpuset-cpus "$SERVER_CPUS" \
    --cpu-shares 8192 "${server_dns[@]}" "${server_env[@]}" -v "$ROOT:/w:ro" -w /w "$NODE_IMAGE" \
    sh -c "${servers}wait" >/dev/null
if [ "$mode" = live ]; then
    docker network connect bridge perf-server
else
    docker network connect --ip "$SERVER_IP2" "$NET_ORIGIN" perf-server
fi
docker start perf-server >/dev/null
for n in "${!sites[@]}"; do
    for try in $(seq 50); do
        docker exec perf-server wget -q -O /dev/null "http://127.0.0.1:$((SITE_PORT + n))/" 2>/dev/null && break
        [ "$try" -lt 50 ] || perf_die "${sites[n]} does not answer on port $((SITE_PORT + n))"
        sleep 0.2
    done
done
# The origin 10 ms away, like a data center close to the big CDNs
if [ "$mode" = replay ]; then
    pid=$(docker inspect -f '{{.State.Pid}}' perf-wpr)
    nsenter -t "$pid" -n tc qdisc replace dev eth0 root netem delay 10ms
fi
if [ "${PERF_TUNE:-0}" = 1 ]; then
    pid=$(docker inspect -f '{{.State.Pid}}' perf-server)
    dev=$(docker exec perf-server sh -c "ip -o -4 addr show | awk '/10\\.77\\.1\\./{print \$2}'")
    nsenter -t "$pid" -n sysctl -qw net.ipv4.tcp_slow_start_after_idle=0
    nsenter -t "$pid" -n ip route replace 10.77.1.0/24 dev "$dev" proto kernel scope link src "$SERVER_IP" \
        initcwnd 40 initrwnd 40
fi
echo "perf server running ($mode, ${#sites[@]} sites)"
