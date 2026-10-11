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

## CI

`.github/workflows/ci.yml`:

| Job | Was |
|---|---|
| lint | shellcheck fuer `tools/*.sh`, Format von `versions.env` |
| toolchain | Toolchain-Image bauen + nach ghcr.io pushen (nur wenn noch nicht vorhanden) |
| toolchain-check | `tools/check-toolchain.sh` im Image |
| webkit-source | WebKit holen + Patches pruefen |

Spaeter kommen dazu: deps, jsc, webkit (mit ccache, aufgeteilt wegen 6h-Limit pro Job),
web, e2e, deploy.
