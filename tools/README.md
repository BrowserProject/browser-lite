# tools/

Scripts for build, packaging and release. The shell scripts load `env.sh` (paths,
`versions.env`, `bl_log`/`bl_die`). Builds run in the toolchain image
([docs/build.md](../docs/build.md)).

| File | Purpose |
| --- | --- |
| `env.sh` | shared paths and versions, loaded with `source` |
| `build-toolchain.sh` | builds the toolchain image with the pins of `versions.env` |
| `check-toolchain.sh` | checks the toolchain image (emcc with pthreads, Meson version) |
| `check-style.sh` | mechanical rules of `AGENTS.md` (CI lint), exceptions in `check-style.allow` |
| `check-packages.mjs` | part of `check-style.sh`: exact npm pins, one version for all packages |
| `fetch-webkit.sh` | fetches the pinned WebKit commit into `third_party/WebKit` (shallow, sparse) |
| `apply-patches.sh` | resets WebKit and applies `engine/patches/`, `--check` only checks and leaves WebKit unpatched |
| `export-patch.sh` | saves new changes in `third_party/WebKit` as a patch |
| `gen-angle-shim.py` | generates the ANGLE replacement for WebGL (output goes into patch 0016) |
| `build-jsc.sh` | JavaScriptCore and the `jsc` shell into `build/jsc/bin/` |
| `build-webcore.sh` | WebCore, the engine and its WTF tests (`tests/engine/wtf-tests.cpp`) into `build/webcore/bin/` |
| `package-engine.sh` | engine for delivery: `engine/<hash>/` with .br/.gz, `manifest.json`, notices |
| `engine-manifest.mjs` | writes `manifest.json` (version, pins, SHA256 of the files) |
| `gen-notices.mjs` | writes `THIRD_PARTY_NOTICES.txt` (runs in the toolchain image) |
| `licenses.txt` | SPDX and license files of every dependency in `deps/sources.txt` |
| `package-demo.sh` | demo site (`apps/demo`) with the packaged engine for the server; with the previous site its engine stays and the new one gets deltas against it |
| `engine-deltas.mjs` | `.dcz` deltas of an engine against the previous one (Compression Dictionary Transport, #244) |
| `build-images.sh` | builds and tests the images `server` and `demo` of the `Dockerfile` |
| `optimize-assets.mjs` | smaller delivered files (no "name" section in .wasm, .br/.gz) |
| `split-engine.mjs` | splits the linked `engine.wasm` into `engine.wasm` and chunks `engine.deferred-<n>.wasm` (build step, #238) |
| `hot-functions.mjs` | records the engine functions common pages run into `engine/hot-functions.txt` |
| `hot-functions-file.mjs` | reads and writes `engine/hot-functions.txt` |
| `wasm-binary.mjs` | shared helper: sections, names, imports and exports of WebAssembly binaries |
| `pins.mjs` | shared helper of the node tools |
