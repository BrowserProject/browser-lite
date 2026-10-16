# relay/

Der Server im Container (`Dockerfile` im Hauptordner): Wisp-Relay (TCP ueber WebSocket,
optional mit Token) und, mit `SITE_DIR`, die fertige Seite (`tools/package-site.sh`) mit den
Headern fuer SharedArrayBuffer (COOP/COEP) und vorkomprimierten Dateien (.br/.gz).
`static.mjs` nutzt auch der Entwicklungs-Server `web/serve.mjs`.

Betrieb und Deploy: [deploy/README.md](../deploy/README.md).

## Sicherheit

- Mit `RELAY_TOKEN` lehnt das Relay jede Verbindung ohne gueltigen Token ab (403). Ohne ist
  es offen, dann nur intern betreiben.
- Private und Loopback-Adressen sind gesperrt (kein Zugriff aufs Netz des Servers).
- Nur Ports 80, 443, 8080, 8443. UDP ist aus (kommt mit WireGuard).
- Pro Verbindung hoechstens 256 gleichzeitige Streams.
- Das Relay loggt keine Inhalte (die sind sowieso TLS-verschluesselt).
