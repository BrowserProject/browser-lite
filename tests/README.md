# tests/

| Ordner | Was | Braucht | CI |
|---|---|---|---|
| `relay/` | `relay-test.mjs`: Relay und Wisp-Client zusammen (Token, Flusskontrolle, Reconnect, SSRF-Sperre, Auslieferung der Seite) | node | ja |
| `wasm/` | WebAssembly der Seiten ohne Engine: Umschreiben der Module (`rewrite-test.mjs`), API ueber die nachgebaute Bruecke (`api-test.mjs`, `bridge-sim.mjs`), Module von Hand (`wasm-bytes.mjs`, auch fuer `e2e/wasm-test.mjs`) | node | ja |
| `jsc/` | JS-Tests mit der `jsc`-Shell in node (`run.sh`): `basics.js`, `calls.js`, `gc-stress.js`, `llint-caches.js`, `resizable.js` | JSC-Build | ja |
| `engine/` | Engine in node ohne Browser: Bild rendern, WebCrypto, Stack-Grenze, GC unter Stress, Grenzen (Speicher, DOM, Strings), Watchdog, WebM-Muxer, Aufraeumen des HTTP-Cache | Engine-Build, `recorder-test.mjs` und `http-cache-test.mjs` nur node | ja |
| `e2e/` | Ganze Kette im echten Chromium (Playwright): Oberflaeche, Engine, Relay, lokale Testserver | Engine-Build, `npm ci` | ja |

## Ohne Build

```bash
node tests/relay/relay-test.mjs
node tests/wasm/rewrite-test.mjs && node tests/wasm/api-test.mjs
node tests/engine/recorder-test.mjs
node tests/engine/http-cache-test.mjs
```

## engine/

`engine-node.mjs` startet die Engine in node (ein View, eine Seite, gleiche
Schnittstelle wie `web/`), `render-test.mjs` und `gc-test.mjs` (mit `gc-stress.html`)
benutzen es. `check-basic.mjs` prueft das Bild von `basic.html`.

```bash
node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/basic.html build/basic.ppm 800 600
node tests/engine/check-basic.mjs build/basic.ppm
RENDER_WAIT_FOR="CRYPTO fertig" node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/crypto.html build/crypto.ppm 200 200
BL_SCRIPT_TIMEOUT=2 RENDER_WAIT_FOR="HANG fertig" node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/hang.html build/hang.ppm 200 200
JSC_slowPathAllocsBetweenGCs=10 node tests/engine/gc-test.mjs build/webcore/bin/engine.js
```

Testseiten mit `RENDER_WAIT_FOR` melden am Ende `<NAME> fertig=ok`: `crypto.html`,
`stack.html`, `limits.html`, `hang.html` (Watchdog, braucht `BL_SCRIPT_TIMEOUT=2`).
`RENDER_TIMEOUT` (Sekunden, Standard 120) aendert das Zeitlimit, `JSC_*` und `BL_*`
(z.B. `BL_DEBUG=1`) gehen an die Engine.
`features.html` ist die Liste fuer `e2e/parity-test.mjs`. `jsbench.html`,
`framebench.html` und `paintbench.html` sind Benchmarks zum Messen von Hand, keine Tests.

## e2e/

```bash
cd tests/e2e && npm ci && npx playwright install chromium
node network-test.mjs [engine-ordner]     # Standard build/webcore/bin
```

Jeder `*-test.mjs` ist ein eigener Test, CI ruft sie einzeln auf: `network`, `input`,
`storage`, `audio`, `media`, `webgl`, `compositing`, `pinch`, `serviceworker`, `webcodecs`,
`mediastream`, `webrtc`, `dragdrop`, `clipboard`, `wasm`, `cache`, `devices`, `ui`,
`parity` und (eigener Job) `site`. Was jeder prueft, steht oben in der Datei.
Alle benutzen `harness.mjs`: Relay und Oberflaeche auf freien Ports (Tests laufen
auch parallel), Hilfsprozesse enden mit dem Test, `check()`/`finish()`, RESULT-Zeilen
der Seite.

- `E2E_TIMEOUT` (ms, Standard 180000), `E2E_VERBOSE=1` (Konsole der Seite und der
  Server, Ablauf der Engine mit `?debug=1`), `CHROMIUM_PATH` (eigenes Chromium).
- `network-test.mjs` macht sich eine Test-CA und Zertifikate in `build/e2e-certs/`
  (braucht `openssl`), auch die, die die Engine ablehnen muss.
- `parity-test.mjs` vergleicht mit dem Host-Chromium. Fehler nur bei Rueckschritten
  gegen `parity-baseline.txt`, `PARITY_UPDATE=1` schreibt die Liste neu.
- `site-test.mjs` laedt echte Seiten aus dem Internet (CI: Liste `sites.txt`,
  Screenshots `build/sites/<host>_<pfad>.png`), Schalter `SITE_*` im Kopf des Skripts.
- `fixtures/` enthaelt die WebAssembly-Testdateien fuer `wasm-test.mjs`, eingecheckt,
  neu bauen mit `fixtures/build.sh` im Toolchain-Image.
- Bildschirmfotos der Tests landen in `build/e2e-*.png`.
