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
| `apply-patches.sh` | resets WebKit and applies `engine/patches/`, `--check` only checks |
| `export-patch.sh` | saves new changes in `third_party/WebKit` as a patch |
| `gen-angle-shim.py` | generates the ANGLE replacement for WebGL (output goes into patch 0016) |
| `build-jsc.sh` | JavaScriptCore and the `jsc` shell into `build/jsc/bin/` |
| `build-webcore.sh` | WebCore and the engine into `build/webcore/bin/` |
| `wasm-build-id.mjs` | appends the build ID to `engine.wasm` (called by the engine build) |
| `package-engine.sh` | engine for delivery: `engine/<hash>/` with .br/.gz, `manifest.json`, notices |
| `engine-manifest.mjs` | writes `manifest.json` (version, build ID, pins, SHA256 of the files) |
| `gen-notices.mjs` | writes `THIRD_PARTY_NOTICES.txt` (runs in the toolchain image) |
| `licenses.txt` | SPDX and license files of every dependency in `deps/sources.txt` |
| `package-demo.sh` | demo site (`apps/demo`) with the packaged engine for the server |
| `build-images.sh` | builds and tests the images `server` and `demo` of the `Dockerfile` |
| `optimize-assets.mjs` | smaller delivered files (no "name" section in .wasm, .br/.gz) |
| `wasm-sections.mjs`, `pins.mjs` | shared helpers of the node tools |
