#!/usr/bin/env bash
# Logs every second: <epoch ms> <foreign load on the device cores in cores> <MemAvailable MB>
# <memory pressure, PSI some avg10 %>. Foreign load = busy time of the cores minus the time of
# perf-device and perf-stealer. Runs on the host; stats.mjs drops runs with foreign load.
#
#   tests/perf/foreign.sh "<cores>" <log>
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"
cpus="$1"
log="$2"
usage() {
    local dir
    dir=$(container_cgroup "$1") || { echo 0; return; }
    awk '/usage_usec/ {print $2}' "$dir/cpu.stat" 2>/dev/null || echo 0
}
busy() { awk -v list=" $cpus " '$1 ~ /^cpu[0-9]+$/ { n = substr($1, 4); if (index(list, " " n " ")) s += $2 + $3 + $4 + $7 + $8 + $9 } END { printf "%d", s * 10000 }' /proc/stat; }
psi() { awk '/^some/ { split($2, a, "="); print a[2] }' /proc/pressure/memory 2>/dev/null || echo 0; }
prev_busy=$(busy)
prev_used=$(($(usage perf-device) + $(usage perf-stealer)))
while sleep 1; do
    now_busy=$(busy)
    now_used=$(($(usage perf-device) + $(usage perf-stealer)))
    foreign=$(awk -v b=$((now_busy - prev_busy)) -v c=$((now_used - prev_used)) 'BEGIN { f = (b - c) / 1e6; if (f < 0) f = 0; printf "%.2f", f }')
    echo "$(($(date +%s%N) / 1000000)) $foreign $(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo) $(psi)" >>"$log"
    prev_busy=$now_busy
    prev_used=$now_used
done
