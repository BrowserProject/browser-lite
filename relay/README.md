# relay/

Der Server im Container (`Dockerfile` im Hauptordner): Wisp-Relay (TCP ueber WebSocket, mit
Token geschuetzt) und, mit `SITE_DIR`, die fertige Seite (`tools/package-site.sh`) mit den
Headern fuer SharedArrayBuffer (COOP/COEP) und vorkomprimierten Dateien (.br/.gz).
`static.mjs` nutzt auch der Entwicklungs-Server `web/serve.mjs`.

Betrieb und Deploy: [deploy/README.md](../deploy/README.md).

## Sicherheit

- Ohne gueltigen Token lehnt das Relay jede Verbindung ab (403).
- Private und Loopback-Adressen sind gesperrt (kein Zugriff aufs Netz des Servers).
- Nur Ports 80, 443, 8080, 8443. UDP ist aus (kommt mit WireGuard).
- Pro Verbindung hoechstens 256 gleichzeitige Streams.
- Das Relay loggt keine Inhalte (die sind sowieso TLS-verschluesselt).
