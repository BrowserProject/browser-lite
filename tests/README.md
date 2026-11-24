# tests/

| Suite | What | Needs | CI job |
|---|---|---|---|
| `contract/` | `engine/abi.json` against the engine sources, unsigned pointers in the `EM_JS` glue (`pointers-test.mjs`), dependency direction of the packages | node | js |
| `engine-js/` | JS parts of the engine in node: WebAssembly rewrite and API over a simulated bridge, WebM muxer, HTTP cache keys, cache names, cleanup and ranges | node | js (`npm test`) |
| `engine/` | the engine in node without a browser: test pages (`pages/`), error page, the policy of a typed `data:` or `about:` address, GC stress (also in a generic call of compiled code, with a bound on the memory growth), the JIT's warm-up (`jit-warmup-test.mjs`: briefly run code stays interpreted, hot code compiles), tail calls after tier-up (`pages/tail-calls.html`: the incumbent realm of `postMessage` through `call`, `apply`, `Reflect.apply` and bound functions, `Error.stack`), console calls that run page code only for their first argument like Safari (`pages/console-arguments.html`, `expect` checks the engine's log line), the engine's polyfills and WebAssembly API that print as `[native code]` and `navigator.hardwareConcurrency` from the host's processors (`pages/native-functions.html`), text drawn or measured into a 2D canvas that waits for its lazy fonts, also late in a long task whose layout went on without them (`pages/canvas-text-fonts.html`), what a route change of a page styled like Tailwind restyles: pseudo-elements without `content`, removed sheets, font faces, fonts across a new style resolver and an SVG text (`pages/route-styles.html`: the same style as a fresh one, costs against a restyle of all), `:hover` and `:active` of touches that the page asks `render.mjs` for (`RENDER_TOUCH`) on descendant, sibling, `:is()`, `:not()` and `:has()` rules (`pages/hover-states.html`: the same style as a fresh one after each press, cancel, release and tap, a touch on 15000 more elements less than 3 ms slower with the rules than without), where a finger's pointer events go (`pages/touch-targets.html`: its moves, release and cancel to the element it pressed, which captures the pointer, also when another one came under it), what an animation frame restyles next to `box-sizing: inherit` on every element, selectors on the style attribute and Lottie-like attribute changes of what `<use>` clones (`pages/frame-restyles.html`: the same style as a fresh one, `check-frame-restyles.mjs`: clones updated in place paint like new ones, a transform next to 3000 children and attributes of cloned paths cost a fraction of restyling or cloning them), animation frames of a `::before` or `::after` (`pages/pseudo-animations.html`: the same style as a fresh one, also with an animation of the element, after the animation ended and after a class change, a frame of 200 pulsing `::after` a fraction of restyling their elements), the order of a timer that came due during a long task and the messages posted before its deadline (`pages/task-order.html`: to the window, also behind other tasks of the event loop, of ports, workers, a worker's port and a frame's port, the messages first like in Chromium), a script the user's navigation stops in a promise reaction or a `FinalizationRegistry` callback that calls guest WebAssembly ends alone (`script-stop-test.mjs`: the promise reactions of other views still run), the debug log's steps of the engine thread without the time of a nested event loop (`step-log-test.mjs`: a script's step around an alert of 1.5 s), native WTF tests (`wtf-tests.cpp`, built with the engine as `wtf-tests.js`: the schedule of RunLoop timers, a `MonotonicTime` finer than 1 ms) | engine build | engine |
| `jsc/` | JS tests with the `jsc` shell in node (`run.sh`), also with the JIT (`BL_JIT=1`; `llint-two-shapes.js` in both: a property read that sees two shapes right after changes, deletes, dictionaries and GCs, and at most 1.4 times one shape, `jit-hash.js` only there: its fast paths against int32 twins; `jit-recompile.js` counts the compiles in the JIT's log, `jit-tierup.js` times one long call against many short ones, `jit-calls.js` many callees at one site against one, `jit-keyed.js` many keys and shapes at one site against array elements, `jit-size.js` the module of a large VM-like function at most 12 times its bytecode, `jit-branch-hints.mjs` the branch hints of that module valid (each on an `if` or `br_if`) and at least one per 100 bytes, `jit-warmup-map.js` calls with 8000 warm functions against 500, `jit-literals.js` array literals and getters against the interpreter, also with the GC collecting continuously, `jit-literal-speed.js` an array literal against element writes and a getter against a method call, `jit-scope.js` globals and closure variables against local variables, `jit-elements.js` element reads and writes against the same arithmetic without them) | JSC build | jsc |
| `packages` | DOM tests of the packages in Chromium and Firefox (`packages/*/test/browser.mjs`: ui popups, prompts and dialogs, profile sync with the real OPFS, engine deltas of the server) | packages, Playwright | e2e-core |
| `core/` | `@browser-lite/core` in Chromium and Firefox through the test host page `core/host/`: every engine feature | engine build, packages, Playwright | e2e-core |
| `demo/` | the demo UI (`apps/demo`) in Chromium and Firefox: tabs (also the icons of narrow tabs, the remembered icon of each page in the history and the restored tabs, a click in the middle of a narrow tab and the menu of the tab strip, the lists of Back and Forward, single entries removed from the history panel, links dragged out of the page onto the strip and the address bar), cards of the phone layout's tab overview swiped away, the find bar on a long page, Tab and F6 between the toolbar and the page, the context menu from the menu key and Shift+F10, spell checking of text fields with its menu items, keys typed right after Ctrl+L or Ctrl+F on a busy page, prompts, dialogs, settings, profile, the host's back and forward, code cache after a restart, Reload, + and a typed address after an engine crash, a page's fullscreen on a host without element fullscreen like iPhone Safari, downloads that stream into the host browser's downloads | engine build, packages, Playwright | e2e-demo |
| `examples/` | both [examples](../examples/README.md) in Chromium and Firefox: rendering, relay tokens, own service worker, iframe, strict CSP, Vite build, `npm run relay` | engine build, packages, Playwright | e2e-core |
| `compat/` | real sites of `sites.txt` (`site-test.mjs`, the check of one site in `site-check.mjs`), informational; `host-crash-test.mjs`: the run goes on after its host browser died; `site-check-test.mjs`: the verdicts of the check, also for a page that replaced its console and for a failed host page | engine build, internet | compat |
| `bench/` | benchmarks to run by hand: pages for `engine/render.mjs`, `slow-start.mjs` (first and second start of the packaged demo behind a slow link, `shaper.mjs`) | engine build, Playwright | none |

`lib/` is the shared harness of the browser suites, `fixtures/` holds shared test data (WebAssembly
modules with `wasm/build.sh`, `wasm-bytes.mjs`, `certs.mjs`, `features.html` for the parity test,
the `avif-*.avif` pictures of `core/avif-test.mjs`).

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

`BL_BROWSER=webkit` runs them in Playwright's WebKit, the engine of Safari (not in CI). On Linux it
needs the libraries of Playwright's Docker image of the same version, for example:

```bash
docker run --rm --network host --ipc=host -e BL_BROWSER=webkit -v "$PWD:$PWD" -w "$PWD" \
  mcr.microsoft.com/playwright:v1.63.0-noble node tests/run.mjs core --engine=<dir>
```

There WebKit has no WebGL, OPFS, `MediaRecorder` or fake camera and Playwright does not route
requests of workers, so the tests of those fail; it finds Safari's differences in the rest.

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
answers of the request handlers (`selectAnswer`, `permissionAnswer`, `authAnswers`, `fileAnswer`,
`dialogMode`, ...), `start(options)`, `stop()`, `select(index)`. `answerPageDialogs(page, respond)` of `lib/`
records and answers the in-page dialogs of `@browser-lite/ui` like `page.on('dialog')` the native
ones. `window.blTestOptions`, set before the start
with `page.addInitScript`, is merged into the `BrowserOptions`. Parameters of the host page are
listed at the top of `core/host/host.js` (`persistent`, `namespace`, `device`, `services`, `env`,
engine switches).

## Add a test

Put a `<name>-test.mjs` into the suite folder: engine features into `core/` (only the public core
API through the host page), UI behaviour into `demo/`. Use `check()` per check and `finish()` at
the end, pages report with `console.log('RESULT key=value')` (`collect()`). Comments, labels and
messages in English; a test needs no CI change, `tests/run.mjs` picks it up.
