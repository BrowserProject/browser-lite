# Building

The packages build in seconds; the engine (WebKit to WebAssembly) takes hours the first time.
Most work on the packages, the demo or the docs needs only an engine from CI.

## Packages and demo

```bash
npm ci && npm run build                 # tsc -b: every package to its dist/
npm run check                           # style, Biome, types, contract tests
npm test                                # unit tests of all workspaces
```

Run the demo against an engine folder (from CI or built below):

```bash
PROFILE_DIR=build/profile node packages/server/dist/bin/browser-lite-server.js &   # relay and profile on :5001
npm run dev -w @browser-lite/demo       # Vite on :5173, engine from build/webcore/bin (BL_ENGINE_DIR)
```

Open `http://localhost:5173/?url=https://example.com`. Like in the container (packaged demo and
relay on one port):

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
3. `tools/export-patch.sh 0045-short-description` saves the new changes as
   `engine/patches/0045-short-description.patch`.
4. `tools/apply-patches.sh --check` verifies that all patches apply in order.

Rules: small patches, one topic each, the number gives the order. What does not have to be in
WebKit belongs in `engine/`. Mark changes in WebKit with `PLATFORM(WASM)` or `__EMSCRIPTEN__`.
Porting traps worth knowing: the `EmptyFrameLoaderClient` defaults block everything (policies
dropped, `canHandleRequest()` false), so the engine has a full client; `ENABLE_FTPDIR=ON` breaks
curl without FTP support (every protocol list fails); `Thread::suspend` cannot work without
signals (one thread per VM, no sampling profiler).

Changes to `toolchain/`, `deps/` or `engine/patches/` rebuild large parts of WebKit. Keep the
paths of `build/`, `sysroot/`, `third_party/`, `toolchain/` and `deps/` stable: they are part of
cache keys.

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

Output: `build/webcore/bin/engine.js`, `engine.wasm`, `engine.data`. `ccache` is in the image;
with `CCACHE_DIR` inside the repository the cache survives the container, and
`CCACHE_COMPILERCHECK` keeps it valid for a new toolchain image with the same Emscripten (#161 in
[decisions.md](decisions.md)). Same for `tools/build-jsc.sh`. Quick check in node:

```bash
node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/basic.html build/basic.ppm
node tests/engine/check-basic.mjs build/basic.ppm
```

More suites: [tests/README.md](../tests/README.md).

## Packaging

- `tools/package-engine.sh` packs an engine folder as a release asset.
- `tools/package-demo.sh <engine-dir> <out>` builds the demo with Vite, puts the engine into
  `engine/<hash>/` and precompresses everything (`tools/optimize-assets.mjs`); the result is
  `SITE_DIR` of `browser-lite-server` and of the container image (`Dockerfile`). Deploy:
  [apps/demo/deploy/README.md](../apps/demo/deploy/README.md).

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests; the job list with
names is in the file. In short: lint and style, the JavaScript job (`npm run check` parts, unit
tests, engine JS parts in node, demo build), the toolchain image, WebKit fetch and patch check,
dependencies, JSC with its tests, the engine with node tests, browser suites in Chromium, and the
informational compatibility job with real sites ([compatibility.md](compatibility.md)). After a
green run on `main`, `.github/workflows/deploy.yml` builds the container and deploys the demo.

Costs and caches:

- The engine is cached by a hash of everything that goes into it; an unchanged engine skips the
  build. The sysroot is cached by `deps/` and the toolchain image.
- A cold WebKit build takes longer than GitHub's 6 hour job limit. The jsc and engine jobs stop
  themselves before it (`timeout 320m`) and save ccache under a key with `github.run_attempt`, so
  **re-running the failed job** continues from the saved cache. Older engine ccache entries are
  deleted (10 GB cache limit per repository).
- Node comes from `NODE_VERSION` in `versions.env`; jobs inside the toolchain image use the Node
  of emsdk.
