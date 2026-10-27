# tests/

| Suite | What | Needs | CI job |
|---|---|---|---|
| `contract/` | `engine/abi.json` against the engine sources, dependency direction of the packages | node | js |
| `engine-js/` | JS parts of the engine in node: WebAssembly rewrite and API over a simulated bridge, WebM muxer, HTTP cache keys, cache names, cleanup and ranges | node | js (`npm test`) |
| `engine/` | the engine in node without a browser: test pages (`pages/`), error page, GC stress, native WTF tests (`wtf-tests.cpp`, built with the engine as `wtf-tests.js`) | engine build | engine |
| `jsc/` | JS tests with the `jsc` shell in node (`run.sh`) | JSC build | jsc |
| `packages` | DOM tests of the packages in Chromium and Firefox (`packages/*/test/browser.mjs`: ui popups, prompts and dialogs, profile sync with the real OPFS, engine deltas of the server) | packages, Playwright | e2e-core |
| `core/` | `@browser-lite/core` in Chromium and Firefox through the test host page `core/host/`: every engine feature | engine build, packages, Playwright | e2e-core |
| `demo/` | the demo UI (`apps/demo`) in Chromium and Firefox: tabs, prompts, dialogs, settings, profile, code cache after a restart | engine build, packages, Playwright | e2e-demo |
| `examples/` | both [examples](../examples/README.md) in Chromium and Firefox: rendering, relay tokens, own service worker, iframe, strict CSP, Vite build, `npm run relay` | engine build, packages, Playwright | e2e-core |
| `compat/` | real sites of `sites.txt`, informational | engine build, internet | compat |
| `bench/` | benchmarks to run by hand: pages for `engine/render.mjs`, `slow-start.mjs` (first and second start of the packaged demo behind a slow link, `shaper.mjs`) | engine build, Playwright | none |

`lib/` is the shared harness of the browser suites, `fixtures/` holds shared test data (WebAssembly
modules with `wasm/build.sh`, `wasm-bytes.mjs`, `certs.mjs`, `features.html` for the parity test).

## Run

```bash
npm ci && npm run build && npx playwright install chromium
npm test                                  # package unit tests and engine-js
node tests/run.mjs contract
node tests/run.mjs engine  [filter] [--engine=<dir>]
node tests/run.mjs packages [package]
node tests/run.mjs core    [filter] [--engine=<dir>]
node tests/run.mjs demo    [filter] [--engine=<dir>]
node tests/run.mjs examples [filter] [--engine=<dir>]
node tests/core/input-test.mjs [engine-dir]   # a single test
```

The browser suites run in Chromium; `BL_BROWSER=firefox` runs them in Firefox (CI runs both).
Firefox needs a display for WebGL (headless it has none, `lib/` starts it headed when `DISPLAY`
is set) and an audio output for Web Audio (PulseAudio, a null sink is enough):

```bash
npx playwright install firefox
pulseaudio --start --exit-idle-time=-1
xvfb-run -a env BL_BROWSER=firefox node tests/run.mjs core
```

Checks that need a Chromium-only API (CDP, V8 tracing) print `skip <name> (skipped in firefox)`
instead (`chromiumOnly()` of `lib/browser.mjs`); `permissions()` drops permissions that Firefox
cannot grant, and Chromium switches of a test become Firefox preferences there (fake camera and
microphone, autoplay).

`tests/run.mjs` runs every `*-test.mjs` of the suite one after the other and prints a summary
(GitHub groups in CI, exit code 1 on a failure). The engine folder is `--engine`, `BL_ENGINE_DIR`
or `build/webcore/bin`. The demo suite builds the demo once (Vite, `engine/` links to the engine);
`E2E_SITE_DIR` uses a folder of `tools/package-demo.sh` instead (CI tests the deployable demo).

Environment: `E2E_TIMEOUT` (ms per wait, default 180000), `E2E_VERBOSE=1` (console of the pages
and the servers, engine log), `BL_BROWSER`, `CHROMIUM_PATH`, `FIREFOX_PATH`. Browser tests start
several processes and need a few GB of memory: run one browser test at a time and switch off core
dumps (`ulimit -c 0`), a crashed headless Chromium can write a huge one. Chromium keeps its profile (with the OPFS of the
pages) and, under Playwright, its shared memory in `TMPDIR`: with less than about 1 GB free there,
uploads fail, pages stop loading and renderers crash. In a container without Chromium run them on a
host that has it. `PARITY_UPDATE=1` writes `core/parity-baseline.txt` again, `SITE_*` switches of
`compat/site-test.mjs` are in its head, `SOAK_ROUNDS`/`SOAK_TABS` shorten the two soak tests
(`core/` and `demo/`, shared pages and procedure in `fixtures/soak.mjs`).

## Harness

Every browser test starts its own servers with `startStack()` of `lib/`: the page under test
(`app: 'core'` the host page, `app: 'demo'` the demo with the profile store) and a relay, both
`browser-lite-server` on free ports (ready when `/healthz` answers), plus local test servers.
`stack.app(params)` is the address of the page with relay, token and parameters.

The host page and the demo (with `?debug=1`) expose `window.blTest` (browser, active view,
`open`, `load`, `eval`, `pagePixel`, debug hooks). The host page also has `window.blHost`: recorded
events (`navigation:`, `title:`, `commit:`, `icon-image:`, `permission:`, `external-url:`, ...),
answers of the request handlers (`selectAnswer`, `permissionAnswer`, `fileAnswer`, `dialogMode`,
...), `start(options)`, `stop()`, `select(index)`. `window.blTestOptions`, set before the start
with `page.addInitScript`, is merged into the `BrowserOptions`. Parameters of the host page are
listed at the top of `core/host/host.js` (`persistent`, `namespace`, `device`, `services`, `env`,
engine switches).

## Add a test

Put a `<name>-test.mjs` into the suite folder: engine features into `core/` (only the public core
API through the host page), UI behaviour into `demo/`. Use `check()` per check and `finish()` at
the end, pages report with `console.log('RESULT key=value')` (`collect()`). Comments, labels and
messages in English; a test needs no CI change, `tests/run.mjs` picks it up.
