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

## Auf dem eigenen Server betreiben

1. VPS mit Docker + Docker Compose, eine Domain (A-Record auf den VPS).
2. Auf dem VPS den Ordner anlegen (Standard `/opt/browser-lite`) und dort `.env` schreiben:
   ```
   DOMAIN=browser.example.com
   RELAY_TOKEN=<zufaelliger Wert, z.B. openssl rand -hex 24>
   ```
3. Im GitHub-Repo unter *Settings -> Secrets and variables -> Actions* setzen:
   `VPS_HOST`, `VPS_USER` (mit Docker-Rechten), `VPS_SSH_KEY` (privater Schluessel),
   optional `VPS_PATH`.
4. Danach deployt der Workflow *Deploy* nach jeder gruenen CI auf dem Standard-Branch
   automatisch (Seite + Relay, Caddy holt das HTTPS-Zertifikat selber).
   Von Hand: *Actions -> Deploy -> Run workflow* mit der ID eines CI-Laufs.
5. Einmal `https://browser.example.com/?token=<RELAY_TOKEN>` oeffnen. Der Token wird im
   Browser gespeichert, danach reicht die normale Adresse.

Mehr zum Relay (Sicherheit, Ports): [relay/README.md](relay/README.md).

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
| [docs/architektur.md](docs/architektur.md) | Wie das Ganze aufgebaut ist |
| [docs/entscheidungen.md](docs/entscheidungen.md) | Was wir entschieden haben und warum |
| [docs/roadmap.md](docs/roadmap.md) | Phasen und aktueller Stand |
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
relay/         Wisp-Relay + Caddy fuer den VPS
tests/         JSC-Tests, Engine-Tests (node) und End-to-End Tests (Playwright)
```

## Lizenz

Unser eigener Code: BSD-2-Clause (siehe [LICENSE](LICENSE)).
WebKit wird nicht mitgeliefert und steht unter LGPL-2.1/BSD. Einzelne Dateien in
`engine/src/websocket/` und die mitgebauten Dateien aus `WebKitLegacy/Storage` stammen aus
WebKit und behalten ihre Lizenzkoepfe.
