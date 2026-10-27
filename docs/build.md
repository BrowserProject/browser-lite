# Building

The packages build in seconds; the engine (WebKit to WebAssembly) takes hours the first time.
Most work on the packages, the demo or the docs needs only an engine from CI.

## Packages and demo

```bash
npm ci && npm run build                 # tsc -b: every package to its dist/
npm run check                           # style, Biome, types, contract tests
npm test                                # unit tests of all workspaces
```

The demo runs against an engine folder from CI or built below
([apps/demo/README.md](../apps/demo/README.md)). Like in the container (packaged demo and relay
on one port):

```bash
tools/package-demo.sh build/webcore/bin build/demo
PORT=8080 SITE_DIR=build/demo node packages/server/dist/bin/browser-lite-server.js
```

An engine from CI: download the artifact `engine` of a green CI run into `build/webcore/bin/`.

## Requirements for the engine

- Linux (or WSL2) with `git` and `docker`.
- RAM: about 1.5 GB per compiler process (16 GB for 4 jobs), disk: 30 GB or more.

Versions live only in `versions.env`, those of the dependencies with SHA256 in
`deps/sources.txt`, npm packages in `package-lock.json`. Never put versions into scripts.

## Toolchain

```bash
tools/build-toolchain.sh   # image browser-lite-toolchain with the pins of versions.env
docker run --rm -v "$PWD:/src" browser-lite-toolchain tools/check-toolchain.sh   # emcc with pthreads works
```

If Docker Hub answers "429 Too Many Requests", take the same base image from a mirror:
`BASE_IMAGE=mirror.gcr.io/library/ubuntu:24.04@sha256:<digest> tools/build-toolchain.sh` (digest
from `versions.env`). Details: [toolchain/README.md](../toolchain/README.md). CI builds the image
once and pushes it to `ghcr.io` (tag: Emscripten version plus a hash of `toolchain/` and the pins).

## WebKit

```bash
tools/fetch-webkit.sh      # the pinned commit into third_party/WebKit (shallow, sparse, blobless, about 300 MB)
tools/apply-patches.sh     # reset, then apply engine/patches/*.patch
```

### Changing WebKit

1. `tools/apply-patches.sh` (puts the patched state into the git index of `third_party/WebKit`).
2. Edit files in `third_party/WebKit`.
3. `tools/export-patch.sh <next number>-short-description` saves the new changes as
   `engine/patches/<next number>-short-description.patch`.
4. `tools/apply-patches.sh --check` verifies that all patches apply in order and leaves WebKit
   unpatched; run step 1 again before the next build.

Rules: small patches, one topic each, the number gives the order. What does not have to be in
WebKit belongs in `engine/`. Mark changes in WebKit with `PLATFORM(WASM)` or `__EMSCRIPTEN__`;
fixes of WebKit bugs apply to every platform (patches 0022, 0046) and get a test, in
`tests/engine/wtf-tests.cpp` when no page reaches the bug deterministically.
Porting traps worth knowing: the `EmptyFrameLoaderClient` defaults block everything (policies
dropped, `canHandleRequest()` false), so the engine has a full client; `ENABLE_FTPDIR=ON` breaks
curl without FTP support (every protocol list fails); `Thread::suspend` cannot work without
signals (one thread per VM, no sampling profiler).

Changes to `toolchain/`, `deps/` or `engine/patches/` rebuild large parts of WebKit; the rules
for them are in [AGENTS.md](../AGENTS.md#expensive-changes).

## Dependencies

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/build-all.sh   # about 30 to 45 min
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/test.sh        # smoke test
```

Output: `sysroot/` (headers, static libraries) and `sysroot/runtime/` (fonts, fontconfig, CA
certificates), which becomes `engine.data`. Recipes and stamps: [deps/README.md](../deps/README.md).

## JavaScriptCore alone

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tools/build-jsc.sh
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tests/jsc/run.sh
```

## Engine

```bash
source versions.env
docker run --rm -v "$PWD:/src" -w /src -e BL_JOBS=4 \
  -e CCACHE_DIR=/src/build/ccache -e CCACHE_COMPILERCHECK="string:emsdk-$EMSDK_VERSION" \
  browser-lite-toolchain tools/build-webcore.sh
```

Output: `build/webcore/bin/engine.js`, `engine.wasm`, `engine.deferred-<n>.wasm`, `engine.data`
(and `engine.full.wasm`, the unsplit module, see below). The same sources at the
same paths give the same files and so the same content hash of the packaged engine
(`engine/<hash>/`), which keeps the host browser's HTTP and code cache valid; no step may embed a
date (OpenSSL gets a fixed `SOURCE_DATE_EPOCH`).

`ccache` is in the image; with `CCACHE_DIR` inside the repository the cache survives the
container, and `CCACHE_COMPILERCHECK` keeps it valid for a new toolchain image with the same
Emscripten (#161 in [decisions.md](decisions.md)). Same for `tools/build-jsc.sh`. Quick check in
node:

```bash
node tests/engine/render.mjs build/webcore/bin tests/engine/pages/basic.html build/basic.ppm
node tests/engine/check-basic.mjs build/basic.ppm
```

More suites: [tests/README.md](../tests/README.md).

### Split engine

After the link `tools/split-engine.mjs` (binaryen's `wasm-split`, `wasm-merge`, `wasm-as` of the
image) splits `engine.wasm` in two (#238 in [decisions.md](decisions.md)): `engine.wasm` keeps
the functions of `engine/hot-functions.txt` and what the `bl_` exports and the functions the page
main thread ran reach through direct calls, the rest goes into chunks `engine.deferred-<n>.wasm` of about 2 MB
of code, sorted by class, that load after the start (`engine/js/deferred.js`). The linked module stays as `engine.full.wasm` (not delivered).
`-DBROWSER_LITE_SPLIT_ENGINE=OFF` keeps one module.

`engine/hot-functions.txt` comes from a run of the demo over common sites with the unsplit
engine: every function of that build, the ones that did not run marked cold. Only cold functions
are deferred, so newer code stays in `engine.wasm` until the list is renewed. Renew it after
changes that add or rename much engine code (a WebKit update), or when
`tests/core/deferred-test.mjs` finds the start needing a chunk; a deferred function still works,
a thread only waits for its chunk when it needs one
before that download is through. `--add` only marks what a scenario ran as hot in the existing
list (the page with text in other scripts whose fonts are held back, and given addresses):

```bash
npm run build
node tools/hot-functions.mjs build/webcore/bin   # writes engine/hot-functions.txt
node tools/hot-functions.mjs build/webcore/bin --add https://example.com/   # only adds
```

## Packaging

- `tools/package-engine.sh [--no-notices] <engine-dir> <out>` packs an engine folder for
  delivery: `<out>/engine/<hash>/` with `.br`/`.gz`, `manifest.json` and
  `THIRD_PARTY_NOTICES.txt` (`tools/gen-notices.mjs`, inside the toolchain image). CI uploads it
  as the artifact `engine-dist`.
- `tools/build-images.sh <demo-site-dir|-> <revision>` builds and tests the images of the
  `Dockerfile` (targets `server` and `demo`).
- A tag `v<version>` runs `.github/workflows/release.yml`: it takes `engine-dist` of the green CI
  run of that commit and publishes `browser-lite-engine-<version>.tar.gz`, the package tarballs
  (`npm pack`), `SHA256SUMS` and the server image `SERVER_IMAGE:<version>`.
- `tools/package-demo.sh <engine-dir> <out>` builds the demo with Vite, puts the engine into
  `engine/<hash>/` and precompresses everything (`tools/optimize-assets.mjs`); the result is
  `SITE_DIR` of `browser-lite-server` and of the container image (`Dockerfile`). Deploy:
  [apps/demo/deploy/README.md](../apps/demo/deploy/README.md).

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests; the job list with
names is in the file. In short: lint and style, the JavaScript job (`npm run check`, unit
tests, engine JS parts in node, demo build), the toolchain image, WebKit fetch and patch check,
dependencies, JSC with its tests, the engine with node tests, browser suites in Chromium (the
core suites, the DOM tests of the packages, the examples, the demo suites), and the
informational compatibility job with real sites ([compatibility.md](compatibility.md)). After a
green run on `main`, `.github/workflows/deploy.yml` builds the container and deploys the demo.

Costs and caches:

- The engine and the jsc shell are cached by a hash of everything that goes into them: their
  files, the `WEBKIT_*` pins of `versions.env` and the toolchain image tag (Emscripten); an
  unchanged engine or jsc skips its build, other pins do not rebuild them. The sysroot is
  cached by `deps/` and the toolchain image.
- A cold WebKit build takes longer than GitHub's 6 hour job limit. The jsc and engine jobs stop
  themselves before it (`timeout 320m`) and save ccache under a key with `github.run_attempt`, so
  **re-running the failed job** continues from the saved cache. The job `ccache-prune` keeps only
  the newest jsc and engine ccache entry (10 GB cache limit per repository).
- Node comes from `NODE_VERSION` in `versions.env`; jobs inside the toolchain image use the Node
  of emsdk.
