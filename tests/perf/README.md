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
  (else no OPFS and no caches) and its own origin per engine (storage lock, OPFS, HTTP cache and
  service worker are never shared).
- **Memory**: `run.mjs`, `start.mjs` and `frames.mjs` record `memMB` (`memory.current` of the
  device, with page cache), `anonMB` (`anon` of `memory.stat`, without page cache), `run.mjs` and
  `frames.mjs` also `wasmMB` (size of the WebAssembly memory, `blTest.measurements()`).
  `run.mjs --mem-high <MB>` limits the device with `memory.high`.
- **Start** (`start.mjs`, visit `cold` for the first of three starts per profile, `warm` for the
  others): besides ready and first layout the steps of the core
  (`performance.mark('bl:<step>')`: `lock`, `beforeStart`, `engine.js`, `engine.data`, `compile`
  of `engine.wasm`, `instantiate`, `main`, `ready`, `prepared`) as `mark<Step>`, the times of the
  engine (`engineMain`, `engineThreadTimes` of every `pthread_create` before ready,
  `engineCompositorReady`, `engineReady`) and the download of `engine.wasm` (`wasmStart`,
  `wasmEnd`), all in ms of `performance.now()` of the page, without a log. The Web Workers before
  `main()` and the moment of the spare ones are measurement options (`engine.env` of a
  configuration, only with `debug`): `BL_POOL_WORKERS` (default 8), `BL_SPARE_WORKERS` and
  `BL_SPARE_WORKERS_AT` (`start`, `ready` or `paint`).
- **Frames** (`frames.mjs --page video|video360|webgl|anim|scroll|idle`): over 20 s, from 8 s after the first
  shown frame on (every run starts cold), `cpuPerSecond` (CPU seconds per second of the device), `fps` (frames shown per second),
  `cpuPerFrame` and memory, for every arm and Chromium itself (arm `chromium`). browser-lite counts
  in the compositor: frames with a new video or WebGL image, all frames with a change for `anim`
  and `scroll` (also with `BL_DAMAGE=0`, which shows every frame; an engine before #220 counts
  every frame).
  Chromium counts `totalVideoFrames` minus `droppedVideoFrames` and the frames the WebGL page drew
  (none for `anim` and `scroll`).
  `video360` (`PERF_VIDEO360_URL`) stays below saturation, where CPU per frame is a quantity of its
  own. `scroll` changes the whole view in every frame, `idle` runs an animation outside the view
  (nothing visible changes, only `cpuPerSecond` is reported). Video pages need the live server.
  The damage switch `BL_DAMAGE` (`0` or `target`, `engine.env` of a configuration, only with
  `debug`) is the measurement option of `plans/damage.json`.
- `foreign.sh` logs foreign load on the device cores and memory pressure every second;
  `stats.mjs` drops runs with either.

## Run

By hand on GitHub: *Actions, Perf, Run workflow* with a plan from `plans/` and `engine_runs`, the
green CI runs whose engines become site 0, 1, ... (empty: the latest green run of `main` for every
site). Each site is packaged with the demo of its own commit, because engine and core go together.

```bash
gh workflow run perf.yml -f plan=probe                                   # same engine twice
gh workflow run perf.yml -f plan=probe -f engine_runs=<E0 run>,<E1 run>  # one run per site
```

Locally (Docker, root for netem): build the packages, package one site per engine, then

```bash
tools/package-demo.sh <engine-dist or engine folder> build/perf/site-0
sudo -E bash tests/perf/group.sh tests/perf/plans/<plan>.json <group>
node tests/perf/stats.mjs build/perf/results/*.jsonl --plan tests/perf/plans/<plan>.json
```

A plan has `groups`, a group has `record` (sites) and `sections` with `kind` (`run.mjs`,
`start.mjs`, `frames.mjs` or `wpe-run.mjs`), `profile`, `net`, `args` and optionally `tune`
and `configs`. `configs` (of the section or the plan) are the arms, taken in ABBA order:
`{"name": "E1", "site": 1, "params": {...}, "engine": {...}}` with the site, parameters of the demo
URL and engine options (`window.blTestOptions`, for example `{"env": {...}}`). The demo takes
them only with `?debug=1` (#205), so they are for measuring only; like everything here they go
away with this folder.

## Evaluation

`stats.mjs` drops disturbed runs (foreign load while `t0` to `t0 + wall`), compares every arm
with a base per site (ratio of the medians) and over the sites (G, geometric mean) with bootstrap
intervals (95 %), and suggests the runs per arm for a half width of 3 % of G (at most 30; start
with a pilot of 5). G < 1 means the arm is better (for `fps` the ratio is base/arm). Primary
metrics have little noise (`cpu`, `rx`, `firstLayout`), `loaded` is
secondary (wiki and weather vary a lot). `compare` of the plan names base, arms and rule:
`lever` (rule R: on C a clear win, G <= 0.95 with the upper bound below 1, nowhere an upper bound
above 1.03), `correction` (nowhere a significant disadvantage above 3 %: G above 1.03 with the
lower bound above 1; G above 1.03 with 1 inside the interval passes as not significant and is
listed under the verdict), both with a veto at +10 % `anonMB` and at crashes
(a section where only the arm crashes, or more crashes with p < 0.05), and `probe` (1.00 inside
the intervals; about 5 % of them miss by chance, so it allows the misses of Binomial(k, 0.05) at
95 %). The workflow writes tables and verdict into the job summary.

## Remove together with this folder

Hooks outside the folder that exist only for these measurements (#214):

- Engine: `engine/src/Measurements.cpp` and `.h`, the export `bl_measurements` (`engine/abi.json`
  with a new `abiVersion`, `BL_TEST_HOOKS` doc), `--wrap=pthread_create` in `engine/engine.cmake`,
  the calls in `main.cpp`, `Compositor.cpp`, `LayerTreeHostWasm.cpp` and `.h` (`newVideoFrame`,
  contents buffer check, `frameShown`) and `media/MediaPlayerPrivateWasm.cpp` and `.h`
  (`m_lastPaintedFrame`), the line in `engine/README.md`.
- Core: `debug.measurements()` and `EngineMeasurements` (`packages/core/src/debug.ts`,
  `types.ts`, `_bl_measurements` and `onRuntimeInitialized` in `engine.ts`), the `bl:<step>`
  marks and `onRuntimeInitialized` in `browser.ts`, the note in `packages/core/README.md`.
- Tests and demo: `measurements` of `blTest` (`apps/demo/src/test-hooks.ts`, `apps/demo/README.md`,
  `tests/core/host/host.js`) and its checks in `tests/core/smoke-test.mjs`,
  `tests/core/media-test.mjs` and `tests/core/webgl-test.mjs`.
- Pool timing (U6, until the fixed value is decided): `-sPTHREAD_POOL_SIZE=Module.blPoolWorkers` in
  `engine/engine.cmake` (back to a number), its default in `engine/js/engine-pre.js`,
  `blPoolWorkers` and the env entries `BL_POOL_WORKERS` and `BL_SPARE_WORKERS_AT` in
  `engine/abi.json`, `poolWorkers` in `packages/core/src/config.ts`, `browser.ts` and
  `test/config.test.mjs`, `blPoolWorkers` of `EngineModule` in `packages/core/src/engine.ts`,
  `SpareWorkersAt` in `engine/src/EngineConfig.h`, `.cpp`, `Engine.h`, `main.cpp` and `WebView.cpp`
  (`firstPaintShown`), the pool part of `tests/core/start-test.mjs`.
- Damage switch (U8, until #220 is confirmed): `BL_DAMAGE` (`0`, `target`) in `engine/abi.json`,
  `DamageUse` in `engine/src/EngineConfig.h` and `.cpp` and its uses in
  `engine/src/LayerTreeHostWasm.cpp`, the target arm there (`target`, `targetHoldsFrame`,
  `composeInFramebuffer`, `damageTarget()`, the release in `setHidden`) and
  `Gpu::createFramebufferLikeSurface`, the arms of `tests/core/damage-test.mjs` (it then needs
  another full repaint to compare against).
- Pins: the `PERF_*` lines of `versions.env`.
- `--mem-high` of `run.mjs` and `device.sh` goes with the folder itself.
