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
- **Engines**: one job measures several engines. Site n (`build/perf/site-<n>`, one per engine) is
  served on port 8080 + n and opens as `localhost:<port>` inside the device: a secure context
  (else no OPFS and no caches) and its own origin per engine (storage lock, OPFS, HTTP and bytecode
  cache and service worker are never shared).
- **Memory**: `run.mjs` and `start.mjs` record `memMB` (`memory.current` of the device, with page cache),
  `anonMB` (`anon` of `memory.stat`, without page cache), `run.mjs` also `wasmMB` (engine memory).
  `run.mjs --mem-high <MB>` limits the device with `memory.high`.
- `foreign.sh` logs foreign load on the device cores and memory pressure every second;
  `stats.mjs` drops runs with either.

## Run

By hand on GitHub: *Actions, Perf, Run workflow* with a plan from `plans/` and `engine_runs`, the
green CI runs whose engines become site 0, 1, ... (empty: the latest green run of `main` for every
site). Each site is packaged with the demo of its own commit, because engine and core go together.

```bash
gh workflow run perf.yml -f plan=probe                          # same engine twice
gh workflow run perf.yml -f plan=bytecode -f engine_runs=<E0 run>,<E1 run>
```

Locally (Docker, root for netem): build the packages, package one site per engine, then

```bash
tools/package-demo.sh <engine-dist or engine folder> build/perf/site-0
sudo -E bash tests/perf/group.sh tests/perf/plans/<plan>.json <group>
node tests/perf/stats.mjs build/perf/results/*.jsonl --plan tests/perf/plans/<plan>.json
```

A plan has `groups`, a group has `record` (sites) and `sections` with `kind` (`run.mjs`,
`start.mjs`, `video.mjs` or `wpe-run.mjs`), `profile`, `net`, `args` and optionally `tune`
and `configs`. `configs` (of the section or the plan) are the arms, taken in ABBA order:
`{"name": "E1", "site": 1, "params": {...}, "engine": {...}}` with the site, parameters of the demo
URL and engine options (`window.blTestOptions`, for example `{"env": {...}}`). The demo takes
them only with `?debug=1` (#205), so they are for measuring only. The arm without bytecode cache
(`plans/bytecode.json`) sets the expert switch `BL_BUILD_ID` empty (`BL_BYTECODE_CACHE` is
core-owned); like everything here it goes away with this folder.

## Evaluation

`stats.mjs` drops disturbed runs (foreign load while `t0` to `t0 + wall`), compares every arm
with a base per site (ratio of the medians) and over the sites (G, geometric mean) with bootstrap
intervals (95 %), and suggests the runs per arm for a half width of 3 % of G (at most 30; start
with a pilot of 5). G < 1 means the arm is better (for `hits` the ratio is base/arm). Primary
metrics have little noise (`cpu`, `rx`, `hits` once recorded, `firstLayout`), `loaded` is
secondary (wiki and weather vary a lot). `compare` of the plan names base, arms and rule:
`lever` (rule R: on C a clear win, G <= 0.95 with the upper bound below 1, nowhere an upper bound
above 1.03), `correction` (nowhere above 1.03), both with a veto at +10 % `anonMB` and at crashes
(a section where only the arm crashes, or more crashes with p < 0.05), and `probe` (1.00 inside
the intervals; about 5 % of them miss by chance, so it allows the misses of Binomial(k, 0.05) at
95 %). The workflow writes tables and verdict into the job summary.
