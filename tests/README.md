# tests/

| Ordner | Was | Braucht | CI |
|---|---|---|---|
| `relay/` | `relay-test.mjs`: Relay und Wisp-Client zusammen (Token, Flusskontrolle, Reconnect, tote Verbindung, SSRF-Sperre, Gruende und Grenze pro Ziel, Auslieferung der Seite) | node | ja |
| `wasm/` | WebAssembly der Seiten ohne Engine: Umschreiben der Module (`rewrite-test.mjs`), API ueber die nachgebaute Bruecke (`api-test.mjs`, `bridge-sim.mjs`), Module von Hand (`wasm-bytes.mjs`, auch fuer `e2e/wasm-test.mjs`) | node | ja |
| `jsc/` | JS-Tests mit der `jsc`-Shell in node (`run.sh`): `basics.js`, `calls.js`, `gc-stress.js`, `llint-caches.js`, `resizable.js` | JSC-Build | ja |
| `contract/` | `abi-test.mjs`: `engine/abi.json` against the engine sources (exports, events, environment, module hooks, features) | node | ja |
| `engine/` | Engine in node without a browser: rendering, WebCrypto, stack limit, GC under stress, limits (memory, DOM, strings), watchdog, features and host bridges, WebM muxer, HTTP cache cleanup | engine build, `recorder-test.mjs` and `http-cache-test.mjs` node only | ja |
| `e2e/` | Ganze Kette im echten Chromium (Playwright): Oberflaeche, Engine, Relay, lokale Testserver | Engine-Build, `npm ci` | ja |

## Ohne Build

```bash
tools/check-style.sh
node tests/relay/relay-test.mjs
node tests/wasm/rewrite-test.mjs && node tests/wasm/api-test.mjs
node tests/engine/recorder-test.mjs
node tests/engine/http-cache-test.mjs
node tests/contract/abi-test.mjs
```

## engine/

`engine-node.mjs` starts the engine in node (one view, one page, the contract of
`engine/abi.json`), `render-test.mjs` and `gc-test.mjs` (with `gc-stress.html`) use it.
`check-basic.mjs` checks the frame of `basic.html`.

```bash
node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/basic.html build/basic.ppm 800 600
node tests/engine/check-basic.mjs build/basic.ppm
RENDER_WAIT_FOR="CRYPTO done" node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/crypto.html build/crypto.ppm 200 200
BL_SCRIPT_TIMEOUT=2 RENDER_WAIT_FOR="HANG done" node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/hang.html build/hang.ppm 200 200
BL_FEATURES= RENDER_URL="file:///test/?features=none" RENDER_WAIT_FOR="BRIDGES done" node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/bridges.html build/bridges.ppm 200 200
JSC_slowPathAllocsBetweenGCs=10 node tests/engine/gc-test.mjs build/webcore/bin/engine.js
```

Test pages with `RENDER_WAIT_FOR` report `<NAME> done=ok` at the end: `crypto.html`,
`stack.html`, `limits.html`, `hang.html` (watchdog, needs `BL_SCRIPT_TIMEOUT=2`),
`bridges.html` (`?features=none` with `BL_FEATURES=` or `?features=all`).
`RENDER_TIMEOUT` (seconds, default 120) changes the time limit, `RENDER_URL` the page URL,
`JSC_*` and `BL_*` (e.g. `BL_DEBUG=1`) go to the engine.
`features.html` is the list for `e2e/parity-test.mjs`. `jsbench.html`, `framebench.html`
and `paintbench.html` are benchmarks to measure by hand, no tests.

## e2e/

```bash
npm ci && npx playwright install chromium
node network-test.mjs [engine-ordner]     # Standard build/webcore/bin
```

Jeder `*-test.mjs` ist ein eigener Test, CI ruft sie einzeln auf: `network`, `input`,
`storage`, `audio`, `media`, `webgl`, `compositing`, `paintworklet`, `pinch`,
`serviceworker`, `webcodecs`, `mediastream`, `webrtc`, `dragdrop`, `clipboard`, `wasm`,
`cache`, `devices`, `ui`, `background`, `soak`, `parity` und (eigener Job) `site`. Was jeder prueft, steht oben in
der Datei. Alle benutzen `harness.mjs`: Relay und Oberflaeche auf freien Ports (Tests laufen
auch parallel), Hilfsprozesse enden mit dem Test, `check()`/`finish()`, RESULT-Zeilen
der Seite.

- `E2E_TIMEOUT` (ms, Standard 180000), `E2E_VERBOSE=1` (Konsole der Seite und der
  Server, Ablauf der Engine mit `?debug=1`), `CHROMIUM_PATH` (eigenes Chromium).
- `storage-test.mjs` startet Chromium mit eigenem Profil auf der Platte (`launchProfile`):
  in einem Kontext von `newContext()` (wie inkognito) liegt das OPFS im RAM, und Chromium
  lehnt Schreiben ab, wenn der Rechner wenig freien Speicher hat.
- `network-test.mjs` macht sich eine Test-CA und Zertifikate in `build/e2e-certs/`
  (braucht `openssl`), auch die, die die Engine ablehnen muss.
- `parity-test.mjs` vergleicht mit dem Host-Chromium. Fehler nur bei Rueckschritten
  gegen `parity-baseline.txt`, `PARITY_UPDATE=1` schreibt die Liste neu.
- `soak-test.mjs`: langer Lauf (viele Navigationen, Tabs auf und zu), Dokumente und Speicher
  muessen begrenzt bleiben. `SOAK_ROUNDS` (Standard 40 Runden durch 5 Seiten), `SOAK_TABS`
  (Standard 30).
- `ui-test.mjs` laesst die Engine mit `?env=BL_TEST_HOOKS=1` wirklich abstuerzen
  (`bl_crash_for_testing`: abort und WASM-Trap), ohne den Schalter tut der Aufruf nichts.
- `site-test.mjs` laedt echte Seiten aus dem Internet (CI: Liste `sites.txt`,
  Screenshots `build/sites/<host>_<pfad>.png`), Schalter `SITE_*` im Kopf des Skripts.
- `fixtures/` enthaelt die WebAssembly-Testdateien fuer `wasm-test.mjs` (auch memory64),
  eingecheckt, neu bauen mit `fixtures/build.sh` im Toolchain-Image.
- Bildschirmfotos der Tests landen in `build/e2e-*.png`.
