# Bauen

## Voraussetzungen

- Linux (oder WSL2) mit `git` und `docker`
- Fuer WebCore und Engine: viel RAM (16 GB+) und Platz (30 GB+)

Versionen stehen in `versions.env`, die der Dependencies mit SHA256 in `deps/sources.txt`,
npm-Pakete in den `package-lock.json`. Nie Versionen direkt in Skripten eintragen.

## Toolchain

```bash
tools/build-toolchain.sh   # Pins aus versions.env, Image browser-lite-toolchain

# Test: kann emcc ein Programm mit pthreads bauen und ausfuehren?
docker run --rm -v "$PWD:/src" browser-lite-toolchain tools/check-toolchain.sh
```

Falls Docker Hub "429 Too Many Requests" sagt, das gleiche Basis-Image von einem Mirror
nehmen: `BASE_IMAGE=mirror.gcr.io/library/ubuntu:24.04@sha256:<Digest> tools/build-toolchain.sh`
(Digest aus `versions.env`).
Details in [toolchain/README.md](../toolchain/README.md).

In CI wird das Image automatisch gebaut und nach `ghcr.io` gepusht (Tag enthaelt die
Emscripten-Version und einen Hash ueber `toolchain/` und die Pins). Gibt es das Image schon, wird es
nicht neu gebaut.

## WebKit

```bash
tools/fetch-webkit.sh      # holt den gepinnten Commit nach third_party/WebKit
tools/apply-patches.sh     # setzt zurueck und wendet engine/patches/*.patch an
```

`fetch-webkit.sh` laedt nur einen Commit (shallow), ohne die riesigen Test-Ordner
(sparse) und Dateiinhalte erst beim Auschecken (blobless). Ca. 300 MB Download.
Netzfehler beim Holen und Auschecken werden wiederholt.

## WebKit aendern (Patch-Workflow)

1. `tools/apply-patches.sh` (legt den gepatchten Stand ins Git-Index von third_party/WebKit)
2. Dateien in `third_party/WebKit` aendern
3. `tools/export-patch.sh 0005-kurze-beschreibung` speichert die neuen Aenderungen als
   `engine/patches/0005-kurze-beschreibung.patch`
4. `tools/apply-patches.sh --check` pruefen ob alle Patches sauber hintereinander passen

Regeln:
- Patches klein halten, ein Thema pro Patch, Nummer vorne fuer die Reihenfolge.
- Was nicht in WebKit sein muss, gehoert nach `engine/`.
- In Code-Aenderungen in WebKit immer `PLATFORM(WASM)` bzw. `__EMSCRIPTEN__` verwenden,
  damit klar ist was von uns kommt.

## Dependencies

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/build-all.sh   # ca. 30-45 min
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/test.sh        # Smoke-Test
```

Das Ergebnis landet in `sysroot/`. Laufzeit-Dateien (Fonts, fontconfig, CA-Zertifikate)
liegen in `sysroot/runtime/` und kommen beim Linken der Engine als Datenpaket (`engine.data`)
ins WASM-Dateisystem. Stamps, Rezepte und `DEP_FILES`: [deps/README.md](../deps/README.md).

## JavaScriptCore alleine

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tools/build-jsc.sh
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tests/jsc/run.sh
```

## Engine (WebCore + engine/)

```bash
source versions.env
docker run --rm -v "$PWD:/src" -w /src -e BL_JOBS=4 \
  -e CCACHE_DIR=/src/build/ccache -e CCACHE_COMPILERCHECK="string:emsdk-$EMSDK_VERSION" \
  browser-lite-toolchain tools/build-webcore.sh
```

Braucht viel RAM (ca. 1.5 GB pro Compiler-Prozess) und mehrere Stunden beim ersten Mal.
`ccache` ist im Image. Mit `CCACHE_DIR` im Repo bleibt der Cache nach dem Container
erhalten, `CCACHE_COMPILERCHECK` haelt ihn auch nach einem neuen Toolchain-Image mit
gleichem Emscripten gueltig. Gleich fuer `tools/build-jsc.sh`. Ergebnis:
`build/webcore/bin/engine.js`, `engine.wasm`, `engine.data`.

Test in node (rendert eine Seite in ein Bild, weitere Tests in
[tests/README.md](../tests/README.md)):

```bash
node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/basic.html build/basic.ppm
node tests/engine/check-basic.mjs build/basic.ppm
```

## Oberflaeche lokal starten

```bash
npm ci && npm run build                 # packages, serve.mjs uses @browser-lite/server
node web/serve.mjs 8080                 # liefert web/ und /engine/ aus build/webcore/bin
```

Dann `http://localhost:8080/?url=https://example.com` oeffnen. Fuer echte Seiten braucht es
das Relay, lokal z.B.:

```bash
npm ci && npm run build
RELAY_ALLOWED_ORIGINS=http://localhost:8080 node packages/server/dist/bin/browser-lite-server.js
# und die Seite mit ?relay=ws://localhost:5001/wisp/ oeffnen
```

`?relay=` gilt nur fuer diesen Browser-Tab, ein leeres `?relay=` nimmt wieder das Relay der
eigenen Seite. Ein Token (`?token=`) wird pro Relay gespeichert. Alle URL-Parameter:
[web/README.md](../web/README.md).

Wie im Container (fertige Seite und Relay auf einem Port):

```bash
tools/package-site.sh build/webcore/bin build/site
npm ci && npm run build
PORT=8080 SITE_DIR=build/site node packages/server/dist/bin/browser-lite-server.js
# http://localhost:8080/
```

## Container und Deploy

Siehe [deploy/README.md](../deploy/README.md).

## CI

`.github/workflows/ci.yml` (Actions immer als `uses: <action>@<commit> # <version>`):

| Job | Was |
|---|---|
| lint | shellcheck fuer alle `*.sh` im Repo, `tools/check-style.sh` (Umlaute und Gedankenstriche, in Patches nur die hinzugefuegten Zeilen, `set -euo pipefail`, `versions.env` mit Digests, Actions per Commit, Runner im LAN nur fuer `deploy`) |
| js | `npm run build`, package tests (`npm test -w @browser-lite/server`, `-w @browser-lite/transport-wisp`), JS parts of the engine in node: `tests/wasm/rewrite-test.mjs`, `api-test.mjs`, `tests/engine/recorder-test.mjs`, `http-cache-test.mjs` |
| toolchain | Toolchain-Image bauen + nach ghcr.io pushen (nur wenn noch nicht vorhanden) |
| toolchain-check | `tools/check-toolchain.sh` im Image |
| webkit-source | WebKit holen + Patches pruefen |
| deps | Dependencies bauen (Cache) + Smoke-Test, sysroot als Artefakt |
| jsc | JavaScriptCore + Tests (inkl. GC-Stresstest) |
| engine | WebCore + Engine bauen, dann in node: Render-Test, WebCrypto, Stack-Grenze, Grenzen (`limits.html`), Watchdog (`hang.html`), GC-Stresstest. Engine als Artefakt |
| e2e | Oberflaeche + Engine + Relay in Chromium (Playwright), jeder Test ein Schritt (auch `paintworklet` und `pinch`), alle laufen auch nach einem roten |
| kompatibilitaet | echte Seiten laden, nur zur Info |

Node kommt aus `NODE_VERSION` in `versions.env` (`actions/setup-node`), in den Jobs im
Toolchain-Image (toolchain-check, deps, jsc, engine) ist es das Node von emsdk.

Nach gruener CI auf `main` baut `.github/workflows/deploy.yml` das Image und startet es auf
dem Server neu ([deploy/README.md](../deploy/README.md)).

Der Engine-Job bricht nach 320 Minuten selber ab und speichert ccache. Der naechste Lauf
macht dann mit dem Cache weiter (GitHub erlaubt hoechstens 6 Stunden pro Job). ccache in
jsc und engine laeuft mit `CCACHE_COMPILERCHECK=string:emsdk-<version>` und nimmt nach einem
neuen Toolchain-Image den Cache eines Images mit gleichem Emscripten.
