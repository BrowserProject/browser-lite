# tests/perf

Performance measurements with emulated weak devices, only while the work on weak devices runs (the
folder goes again afterwards). Not part of CI: the workflow *Perf* runs a plan by hand.

## Setup

```
device (Chromium of Playwright, demo)  --netem--  server (browser-lite-server)  --10 ms--  Web Page Replay + DNS
```

- **Device**: a container on fixed cores. A slower core comes from a realtime thread per core
  (`stealer.mjs`) that takes (F-1)/F of every 2 ms, so the device gets 1/F of each core however many
  threads it runs. Profiles (`lib.sh`): `S` fast 2 cores, `L` older laptop (2, 1.5x), `C` cheap
  Chromebook (2, 3x), `S4` and `A` (6 cores, 6x) need more cores than a CI runner has.
- **Link** (`netem.sh`): `lan`, `dc` (30 ms), `mobile` (80 ms, 20/5 Mbit), `poor` (150 ms, 5/1 Mbit,
  1 % loss), `rtt80` and `rate20` to separate latency and bandwidth.
- **Sites**: each group first records its sites with browser-lite itself into a Web Page Replay
  archive, then every section loads them from the replay. Archives never leave the runner.
- The demo opens as `localhost` inside the device (secure context, else no OPFS and no caches).
- `foreign.sh` logs foreign load on the device cores and memory pressure every second;
  `stats.mjs` drops runs with either.

## Run

By hand on GitHub: *Actions, Perf, Run workflow* with a plan from `plans/`. Locally (Docker, root
for netem): build the packages, package the demo into `build/perf/site`, then

```bash
tools/package-demo.sh <engine-dist or engine folder> build/perf/site
sudo -E bash tests/perf/group.sh tests/perf/plans/<plan>.json <group>
node tests/perf/stats.mjs build/perf/results/<section>.jsonl --metric firstLayout --base <config>
```

A plan has groups, a group has `record` (sites) and `sections` with `kind` (`run.mjs`,
`start.mjs` or `wpe-run.mjs`), `profile`, `net`, `args` and optionally `tune`.
