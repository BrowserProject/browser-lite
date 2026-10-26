# deps/

The engine's libraries (zlib, ICU, freetype, harfbuzz, fontconfig, libxml2, sqlite, OpenSSL,
nghttp2, libcurl, ...) built for WASM, plus runtime files (Noto fonts, fontconfig config and
cache, CA certificates). Skia comes with WebKit.

- `sources.txt`: source of each lib with version and SHA256 (or git commit). The only place
  where their versions live.
- `recipes/<name>.sh`: how a lib is built (function `build`).
- `build-all.sh`: build order and stamps.
- `lib.sh`: shared recipe helpers (flags, download with checksum, cmake, meson, autotools).
- `relocate-pc.sh`: rewrites the pkg-config files to the current sysroot path.
- `test.sh`: smoke test against the finished sysroot (`tests/smoke.cpp`).
- `tools/fc-precache.c`: generates the fontconfig cache at build time.

Output: `sysroot/` (headers, static libs, pkg-config), `sysroot/runtime/` (fonts,
fontconfig, CA certificates), which becomes `engine.data` when the engine is linked, and
`sysroot/lazy/fonts/` (recipe `lazyfonts`: fonts the engine loads on demand, cut with
`tools/slice-fonts.py`), which the engine build copies to `lazy/fonts/`. Both are
gitignored. Run inside the toolchain image, see [docs/build.md](../docs/build.md).

## Building

```bash
deps/build-all.sh               # everything that changed
deps/build-all.sh --force       # rebuild everything
deps/build-all.sh --only icu    # one lib only, ignores stamps
deps/test.sh                    # smoke test
```

Each lib has a stamp in `sysroot/.stamps/`: a hash of its `sources.txt` line, recipe, the files
in `DEP_FILES`, patches in `patches/<name>/`, `lib.sh`, `build-all.sh`, compiler flags and the
stamp of the previous lib. Everything from the first changed lib onwards is rebuilt.

## Adding a dependency

1. Line in `sources.txt` (`name type version url sha256`, type `tar`, `zip`, `file`, `git`
   with commit, or `none`).
   A recipe may fetch more lines with `dep_fetch <name>` (`lazyfonts` takes every `font-*`
   line); such lines have no recipe of their own and no entry in `ORDER`.
2. `recipes/<name>.sh` with a `build` function, usually `dep_cmake`, `dep_meson` or
   `dep_autotools "$SRC" ...`. Extra files the recipe reads go into `DEP_FILES`.
3. Add the name to `ORDER` in `build-all.sh` after its dependencies, and to `pkgs` plus a
   check in `tests/smoke.cpp` / `test.sh` if it is a library.

Update OpenSSL, curl and the CA certificates (`cacert`) regularly: they process data from
arbitrary servers, and the certificate bundle is baked into the engine.
