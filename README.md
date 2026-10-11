# browser-lite

Ein richtiger Browser, der komplett in einem Browser-Tab laeuft.

WebKit (WebCore + JavaScriptCore) wird mit Emscripten nach WebAssembly kompiliert.
Die Seiten werden von WebKit selber geladen, ausgefuehrt und gerendert, die Ausgabe
landet auf einem Canvas. Es gibt kein URL-Rewriting, kein Pixel-Streaming und keine
emulierte VM.

Netzwerk geht ueber das [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)-Protokoll
(WebSocket) zu einem kleinen Relay. TLS passiert im WASM, das Relay sieht also nur
verschluesselte Bytes. Spaeter soll statt dem Relay auch WireGuard moeglich sein.

> **Status:** Phase 0 (Grundlagen). Es gibt noch keinen lauffaehigen Browser.
> Siehe [docs/roadmap.md](docs/roadmap.md).

## Doku

| Datei | Inhalt |
|---|---|
| [docs/architektur.md](docs/architektur.md) | Wie das Ganze aufgebaut ist |
| [docs/entscheidungen.md](docs/entscheidungen.md) | Was wir entschieden haben und warum |
| [docs/roadmap.md](docs/roadmap.md) | Phasen und aktueller Stand |
| [docs/build.md](docs/build.md) | Selber bauen (lokal und CI) |
| [docs/referenz-webkitwasm.md](docs/referenz-webkitwasm.md) | Was wir vom Projekt WebkitWasm gelernt haben |

## Ordner

```
versions.env   alle Versions-Pins (WebKit, Emscripten, ...)
toolchain/     Docker-Image mit Emscripten und allen Build-Tools
tools/         Skripte (WebKit holen, Patches, Checks)
patches/       unsere Aenderungen an WebKit als .patch Dateien
deps/          Dependencies nach WASM bauen (Phase 1)
port/          unser WebKit-Port PORT=Wasm (Phase 3)
engine/        Embedding: Page, Clients, Rendering, Netzwerk (Phase 4+)
web/           Browser-Oberflaeche in TypeScript (Phase 6)
relay/         Wisp-Relay + Caddy fuer den VPS (Phase 5)
tests/         End-to-End Tests mit Playwright
```

## Schnellstart (Phase 0)

```bash
tools/fetch-webkit.sh          # WebKit holen (gepinnt, ohne Test-Ordner, ca. 1 GB)
tools/apply-patches.sh         # unsere Patches anwenden

docker build -t browser-lite-toolchain --build-arg EMSDK_VERSION=6.0.10 toolchain/
docker run --rm -v "$PWD:/src" browser-lite-toolchain tools/check-toolchain.sh
```

## Lizenz

Unser eigener Code: BSD-2-Clause (siehe [LICENSE](LICENSE)).
WebKit wird nicht mitgeliefert und steht unter LGPL-2.1/BSD.
