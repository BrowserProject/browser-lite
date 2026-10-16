# Bauen

## Voraussetzungen

- Linux (oder WSL2) mit `git` und `docker`
- Fuer spaetere Phasen: viel RAM (16 GB+) und Platz (30 GB+)

Alle Versionen stehen in `versions.env`. Nie Versionen direkt in Skripten eintragen.

## Toolchain

```bash
source versions.env
docker build -t browser-lite-toolchain --build-arg EMSDK_VERSION="$EMSDK_VERSION" toolchain/

# Test: kann emcc ein Programm mit pthreads bauen und ausfuehren?
docker run --rm -v "$PWD:/src" browser-lite-toolchain tools/check-toolchain.sh
```

Falls Docker Hub "429 Too Many Requests" sagt, einen Mirror nehmen:
`--build-arg BASE_IMAGE=mirror.gcr.io/library/ubuntu:24.04`.

In CI wird das Image automatisch gebaut und nach `ghcr.io` gepusht (Tag enthaelt die
Emscripten-Version und einen Hash vom Dockerfile). Wenn es das Image schon gibt, wird es
nicht neu gebaut.

## WebKit

```bash
tools/fetch-webkit.sh      # holt den gepinnten Commit nach third_party/WebKit
tools/apply-patches.sh     # setzt zurueck und wendet patches/webkit/*.patch an
```

`fetch-webkit.sh` laedt nur einen Commit (shallow), ohne die riesigen Test-Ordner
(sparse) und Dateiinhalte erst beim Auschecken (blobless). Ca. 300 MB Download.

## WebKit aendern (Patch-Workflow)

1. `tools/apply-patches.sh` (legt den gepatchten Stand ins Git-Index von third_party/WebKit)
2. Dateien in `third_party/WebKit` aendern
3. `tools/export-patch.sh 0005-kurze-beschreibung` speichert die neuen Aenderungen als
   `patches/webkit/0005-kurze-beschreibung.patch`
4. `tools/apply-patches.sh --check` pruefen ob alle Patches sauber hintereinander passen

Regeln:
- Patches klein halten, ein Thema pro Patch, Nummer vorne fuer die Reihenfolge.
- Was nicht in WebKit sein muss, gehoert nach `port/` oder `engine/`.
- In Code-Aenderungen in WebKit immer `PLATFORM(WASM)` bzw. `__EMSCRIPTEN__` verwenden,
  damit klar ist was von uns kommt.

## Dependencies (Phase 1)

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/build-all.sh   # ca. 30-45 min
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain deps/test.sh        # Smoke-Test
```

Alle Quellen stehen mit SHA256 in `deps/sources.txt`, das Ergebnis landet in `sysroot/`.
Laufzeit-Dateien (Fonts, fontconfig, CA-Zertifikate) liegen in `sysroot/runtime/` und kommen
beim Linken der Engine als Datenpaket (`engine.data`) ins WASM-Dateisystem.

## JavaScriptCore alleine (Phase 2)

```bash
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tools/build-jsc.sh
docker run --rm -v "$PWD:/src" -w /src browser-lite-toolchain tests/jsc/run.sh
```

## Engine (WebCore + Embedder, Phase 3/4)

```bash
docker run --rm -v "$PWD:/src" -w /src -e BL_JOBS=4 browser-lite-toolchain tools/build-webcore.sh
```

Braucht viel RAM (ca. 1.5 GB pro Compiler-Prozess) und mehrere Stunden beim ersten Mal.
Mit `ccache` (im Image) gehen spaetere Builds viel schneller. Ergebnis:
`build/webcore/bin/engine.js`, `engine.wasm`, `engine.data`.

Test in node (rendert eine Seite in ein Bild):

```bash
node tests/engine/render-test.mjs build/webcore/bin/engine.js tests/engine/basic.html build/basic.ppm
node tests/engine/check-basic.mjs build/basic.ppm
```

## Oberflaeche lokal starten

```bash
node web/serve.mjs 8080                 # liefert web/ und /engine/ aus build/webcore/bin
```

Dann `http://localhost:8080/?url=https://example.com` oeffnen. Fuer echte Seiten braucht es
das Relay (siehe unten), lokal z.B.:

```bash
cd relay && npm ci && RELAY_TOKEN=lokal-test-token-123456 node server.mjs
# und die Seite mit ?relay=ws://localhost:5001/wisp/&token=lokal-test-token-123456 oeffnen
```

Wie im Container (fertige Seite und Relay auf einem Port):

```bash
tools/package-site.sh build/webcore/bin build/site
RELAY_TOKEN=lokal-test-token-123456 PORT=8080 SITE_DIR=build/site node relay/server.mjs
# http://localhost:8080/?token=lokal-test-token-123456
```

## Container und Deploy

Siehe [deploy/README.md](../deploy/README.md).

## CI

`.github/workflows/ci.yml`:

| Job | Was |
|---|---|
| lint | shellcheck fuer `tools/*.sh`, Format von `versions.env` |
| toolchain | Toolchain-Image bauen + nach ghcr.io pushen (nur wenn noch nicht vorhanden) |
| toolchain-check | `tools/check-toolchain.sh` im Image |
| webkit-source | WebKit holen + Patches pruefen |
| relay | Relay + Wisp-Client zusammen testen |
| deps | Dependencies bauen (Cache) + Smoke-Test, sysroot als Artefakt |
| jsc | JavaScriptCore + Tests (inkl. GC-Stresstest) |
| engine | WebCore + Engine bauen, Render-Test, Engine als Artefakt |
| e2e | Oberflaeche + Engine + Relay in Chromium (Playwright) |
| kompatibilitaet | echte Seiten laden, nur zur Info |

Nach gruener CI auf `main` baut `.github/workflows/deploy.yml` das Image und startet es auf
dem Server neu ([deploy/README.md](../deploy/README.md)).

Der Engine-Job bricht nach 320 Minuten selber ab und speichert ccache. Der naechste Lauf
macht dann mit dem Cache weiter (GitHub erlaubt hoechstens 6 Stunden pro Job).
