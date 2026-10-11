# relay/

Alles fuer den VPS: Caddy (HTTPS, COOP/COEP-Header, statische Dateien) und das
Wisp-Relay (TCP ueber WebSocket, mit Token geschuetzt).

## Einrichten

1. Docker + Docker Compose auf dem VPS installieren, DNS der Domain auf den VPS zeigen lassen.
2. Diesen Ordner auf den VPS kopieren (oder das Repo klonen).
3. `.env` anlegen:
   ```
   DOMAIN=browser.example.com
   RELAY_TOKEN=<zufaelliger langer Wert, z.B. openssl rand -hex 24>
   ```
4. Die gebaute Seite nach `www/` legen (macht der Deploy-Workflow, siehe docs/build.md):
   `www/index.html`, `www/app.js`, ... und `www/engine/engine.js|wasm|data`.
5. `docker compose up -d --build`

Danach einmal `https://browser.example.com/?token=<RELAY_TOKEN>` oeffnen. Der Token
wird im Browser gespeichert, danach reicht `https://browser.example.com/`.

## Sicherheit

- Ohne gueltigen Token lehnt das Relay jede Verbindung ab (403).
- Private und Loopback-Adressen sind gesperrt (kein Zugriff aufs Netz des VPS).
- Nur Ports 80, 443, 8080, 8443. UDP ist aus (kommt mit WireGuard).
- Pro Verbindung hoechstens 256 gleichzeitige Streams.
- Das Relay loggt keine Inhalte (die sind sowieso TLS-verschluesselt).
