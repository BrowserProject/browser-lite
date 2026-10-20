#!/usr/bin/env bash
# Runs one group of a measuring plan (tests/perf/plans/<plan>.json) on this host: setup,
# calibration of the device profiles, recording of the sites of the group (twice cold and warm),
# then every section against the replay. Results in $OUT/results (one JSON lines file per section,
# foreign.log, calib.jsonl, logs).
#
#   tests/perf/group.sh <plan.json> <group>
#
# Section fields: id, kind (run, start, wpe or video; video uses the live server), profile (device
# profile; cores for wpe), net, args (arguments of the runner, split at spaces), configs (arms of
# run and start, default the configs of the plan; see measure.mjs readConfigs, site n is the
# engine in build/perf/site-<n>), tune (true: TCP tuning of the server, see server.sh).
set -euo pipefail
# shellcheck source=tests/perf/lib.sh
source "$(dirname "$0")/lib.sh"
plan="${1:?plan}"
group="${2:?group}"
# Evaluates an expression over the plan (p) and the group (g)
json() { node -e "const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const g = p.groups.find((g) => g.name === process.argv[2]); if (!g) process.exit(3); console.log($1)" "$plan" "$group"; }

sections=$(json "g.sections.length")
if [ "$(json "g.sections.some((s) => s.kind === 'wpe')")" = true ]; then
    bash "$PERF/setup.sh" wpe
else
    bash "$PERF/setup.sh"
fi
mkdir -p "$OUT/results/logs"
ca=/w/build/perf/wpr/ca.pem

for profile in $(json "[...new Set(g.sections.filter((s) => s.kind !== 'wpe').map((s) => s.profile))].join(' ')"); do
    bash "$PERF/device.sh" "$profile" lan node calib.mjs --out /w/build/perf/results/calib.jsonl
done

archive="$group.wprgo"
if [ ! -f "$OUT/archive/$archive" ]; then
    bash "$PERF/server.sh" record "$archive"
    bash "$PERF/device.sh" S lan node run.mjs --ca "$ca" --out /w/build/perf/results/record.jsonl --label record \
        --visit warm --runs 2 --timeout 300 --linger 8000 --sites "$(json "g.record.join(',')")"
    docker kill -s INT perf-wpr >/dev/null
    for _ in $(seq 120); do
        [ "$(docker inspect -f '{{.State.Running}}' perf-wpr)" = false ] && break
        sleep 1
    done
fi

for i in $(seq 0 $((sections - 1))); do
    field() { json "g.sections[$i].$1 ?? ''"; }
    id=$(field id)
    kind=$(field kind)
    profile=$(field profile)
    net=$(field net)
    read -r -a args <<<"$(field args)"
    configs=$(json "JSON.stringify(g.sections[$i].configs ?? p.configs ?? [{ name: 'A' }])")
    tune=$([ "$(field tune)" = true ] && echo 1 || echo 0)
    out="/w/build/perf/results/$id.jsonl"
    echo "== $id ($kind $profile $net)"
    if [ "$kind" = video ]; then
        bash "$PERF/server.sh" live
    else
        PERF_TUNE=$tune bash "$PERF/server.sh" replay "$archive"
    fi
    case "$kind" in
        run) bash "$PERF/device.sh" "$profile" "$net" node run.mjs --ca "$ca" --out "$out" --label "$id" --configs "$configs" "${args[@]}" ;;
        start) bash "$PERF/device.sh" "$profile" "$net" node start.mjs --ca "$ca" --out "$out" --label "$id" --configs "$configs" "${args[@]}" ;;
        video) bash "$PERF/device.sh" "$profile" "$net" node video.mjs --out "$out" --label "$id" "${args[@]}" ;;
        wpe) bash "$PERF/wpe.sh" "$profile" --out "$out" --label "$id" "${args[@]}" ;;
        *) perf_die "unknown kind $kind" ;;
    esac
done
bash "$PERF/server.sh" stop
