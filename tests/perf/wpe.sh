#!/usr/bin/env bash
# Native WPE WebKit in the replay network (like an engine next to the relay). Runs on the host
# after server.sh replay and setup.sh wpe.
#   tests/perf/wpe.sh "<cores>" <wpe-run.mjs arguments...>
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"
cpus="${1:?cores}"
shift
docker rm -f perf-wpe >/dev/null 2>&1 || true
# WebKit's own sandbox (bubblewrap) needs namespaces the container does not give
docker run --rm --name perf-wpe --network "$NET_ORIGIN" --dns "$DNS_IP" --cpuset-cpus "$cpus" --memory 3g \
    --memory-swap 3g --shm-size 1g -e WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 -e WPE_CPUS="$cpus" \
    -v "$ROOT:/w" -w /w/tests/perf bl-perf-wpe node wpe-run.mjs "$@"
