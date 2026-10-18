# tools/

Skripte fuer Build und Auslieferung. Die Shell-Skripte laden `env.sh` (Pfade, `versions.env`,
`bl_log`/`bl_die`). Bauen laeuft im Toolchain-Image ([docs/build.md](../docs/build.md)).

| Datei | Was |
| --- | --- |
| `env.sh` | gemeinsame Pfade und Versionen, wird mit `source` geladen |
| `build-toolchain.sh` | baut das Toolchain-Image mit den Pins aus `versions.env` |
| `check-toolchain.sh` | prueft das Toolchain-Image (emcc mit pthreads, Meson-Version) |
| `check-style.sh` | prueft die mechanischen Regeln aus `AGENTS.md` (Lint der CI), Ausnahmen in `check-style.allow` |
| `fetch-webkit.sh` | holt den gepinnten WebKit-Commit nach `third_party/WebKit` (shallow, sparse) |
| `apply-patches.sh` | setzt WebKit zurueck und wendet `engine/patches/` an, `--check` prueft nur |
| `export-patch.sh` | speichert neue Aenderungen in `third_party/WebKit` als Patch |
| `gen-angle-shim.py` | erzeugt den ANGLE-Ersatz fuer WebGL (Ausgabe kommt in Patch 0016) |
| `build-jsc.sh` | JavaScriptCore und die `jsc`-Shell nach `build/jsc/bin/` |
| `build-webcore.sh` | WebCore und Engine nach `build/webcore/bin/` |
| `wasm-build-id.py` | haengt die Build-ID an `engine.wasm` (ruft der Engine-Build auf) |
| `package-demo.sh` | packages the demo (`apps/demo`) and the engine for the server (for example into `build/demo`) |
| `optimize-assets.mjs` | makes delivered files smaller (no "name" section in .wasm, .br/.gz) |
