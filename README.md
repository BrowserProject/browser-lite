# browser-lite

Ein richtiger Browser, der komplett in einem Browser-Tab laeuft.

WebKit (WebCore + JavaScriptCore) wird mit Emscripten nach WebAssembly kompiliert.
Die Seiten werden von WebKit selber geladen, ausgefuehrt und gerendert, die Ausgabe
landet auf einem Canvas. Es gibt kein URL-Rewriting, kein Pixel-Streaming und keine
emulierte VM.

Netzwerk geht ueber das [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)-Protokoll
(WebSocket) zu einem kleinen Relay auf dem eigenen Server. TLS passiert im WASM, das Relay
sieht also nur verschluesselte Bytes. Spaeter soll statt dem Relay auch WireGuard moeglich sein.

## Stand

Laeuft in Chrome (Chromebook) und Chromium. Getestet und in CI:

- echte HTTPS-Seiten (z.B. Wikipedia, SRF, Google, GitHub, YouTube, OpenStreetMap)
- Tabs mit Favicons, Zurueck/Vor, Popups als neue Tabs, Downloads, Datei-Upload, Dialoge,
  Kontextmenue, Vollbild
- Tastatur inkl. Schweizer Layout und tote Tasten, Copy/Paste, Scrollen
- Cookies, localStorage und IndexedDB bleiben nach dem Neuladen erhalten
- WebSockets der Seiten (ws:// und wss://)
- Web Audio mit Ton (nach dem ersten Klick, wie in Chrome), `decodeAudioData`
- `<video>` und `<audio>` mit Dateien (MP4, WebM, MP3, ...) und MSE (Video-Streaming)
- WebGL 1 und 2 (ueber das WebGL des eigenen Browsers)
- WebAssembly der Seiten (laeuft in der WASM-Engine des eigenen Browsers), auch in Workern

Noch nicht: DRM (EME), WebRTC, WireGuard. JavaScript ist langsamer als in einem
normalen Browser (kein JIT in WASM). Details in [docs/roadmap.md](docs/roadmap.md), welche
Seiten gehen steht in [docs/kompatibilitaet.md](docs/kompatibilitaet.md).

## Betrieb

Alles laeuft in einem Container (`Dockerfile`): `relay/server.mjs` liefert die fertige Seite
aus und ist das Wisp-Relay. Jeder gruene CI-Lauf auf `main` baut das Image, pusht es nach
`ghcr.io/browserproject/browser-lite` und startet es auf dem Server neu (Workflow *Deploy*).
Einrichten und Ablauf: [deploy/README.md](deploy/README.md).

## Lokal ausprobieren

Fertige Engine aus der CI (Artefakt `engine` eines CI-Laufs) nach `build/webcore/bin/` legen
oder selber bauen (siehe [docs/build.md](docs/build.md)), dann:

```bash
(cd relay && npm ci && RELAY_TOKEN=lokal-0123456789abcdef PORT=5001 node server.mjs) &
node web/serve.mjs 8080
# im Browser: http://localhost:8080/?relay=ws://localhost:5001/wisp/&token=lokal-0123456789abcdef
```

Mit `?debug=1` zeigt die Engine in der Konsole, was sie macht (Zeiten, GC, Netzwerk).

## Doku

| Datei | Inhalt |
|---|---|
| [AGENTS.md](AGENTS.md) | Regeln fuer die Arbeit am Repo (auch fuer Agents) |
| [docs/architektur.md](docs/architektur.md) | Wie das Ganze aufgebaut ist |
| [docs/entscheidungen.md](docs/entscheidungen.md) | Was wir entschieden haben und warum |
| [docs/roadmap.md](docs/roadmap.md) | Phasen und aktueller Stand |
| [docs/stand.md](docs/stand.md) | Kurzer Stand, Messwerte und was noch offen ist |
| [docs/build.md](docs/build.md) | Selber bauen (lokal und CI) |
| [docs/referenz-webkitwasm.md](docs/referenz-webkitwasm.md) | Was wir vom Projekt WebkitWasm gelernt haben |

## Ordner

```
versions.env   alle Versions-Pins (WebKit, Emscripten, ...)
toolchain/     Docker-Image mit Emscripten und allen Build-Tools
tools/         Skripte (WebKit holen, Patches, Builds, Seite fuer den Server packen)
patches/webkit unsere Aenderungen an WebKit (PORT=Wasm und Fixes) als .patch Dateien
deps/          Dependencies nach WASM bauen (zlib, ICU, OpenSSL, curl, Fonts, ...)
engine/        Embedding: WebView, Clients, Netzwerk, Speicher, WebSockets, Event-Loop
web/           Browser-Oberflaeche (HTML/CSS/JS ohne Build-Schritt) + Wisp-Client
relay/         Server im Container: Wisp-Relay + fertige Seite
deploy/        Compose-Datei und Einrichtung des Servers (Proxmox-LXC mit Runner)
tests/         JSC-Tests, Engine-Tests (node) und End-to-End Tests (Playwright)
```

## Lizenz

Unser eigener Code: BSD-2-Clause (siehe [LICENSE](LICENSE)).
WebKit wird nicht mitgeliefert und steht unter LGPL-2.1/BSD. Einzelne Dateien in
`engine/src/websocket/` und die mitgebauten Dateien aus `WebKitLegacy/Storage` stammen aus
WebKit und behalten ihre Lizenzkoepfe.
