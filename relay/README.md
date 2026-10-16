# relay/

Der Server im Container (`Dockerfile` im Hauptordner): Wisp-Relay (TCP ueber WebSocket,
optional mit Token) und, mit `SITE_DIR`, die fertige Seite (`tools/package-site.sh`) mit den
Headern fuer SharedArrayBuffer (COOP/COEP), vorkomprimierten Dateien (.br/.gz) und ETag
(304 beim Neuladen). `static.mjs` (Auslieferung und Parsen der URL) nutzt auch der
Entwicklungs-Server `web/serve.mjs`.

Betrieb und Deploy: [deploy/README.md](../deploy/README.md). Test: `tests/relay/relay-test.mjs`.

## Sicherheit

- Mit `RELAY_TOKEN` lehnt das Relay jede Verbindung ohne gueltigen Token ab (403). Ohne ist
  es offen, dann nur intern betreiben.
- Nur oeffentliche Unicast-Adressen (`ipaddr.js`, `range() === 'unicast'`, IPv4-mapped IPv6
  wie `::ffff:127.0.0.1` wird vorher in IPv4 umgewandelt). Gesperrt sind also Loopback,
  private Netze, Link-Local, ULA (`fd00::/8`), NAT64 usw. Namen prueft das Relay bei der
  Aufloesung selbst, so ist genau die Adresse geprueft, mit der es verbindet (kein
  DNS-Rebinding zwischen Pruefen und Verbinden).
- Nur Ports 80, 443, 8080, 8443. UDP ist aus (kommt mit WireGuard).
- `RELAY_ALLOW_LOCAL=1` hebt Adress- und Port-Sperre auf, nur fuer Tests mit lokalen Servern.
- Pro Verbindung hoechstens 256 gleichzeitige Streams.
- Das Relay loggt keine Inhalte (die sind sowieso TLS-verschluesselt).
- SIGTERM beendet sofort (Node ist PID 1 im Container, ohne Handler kaeme erst nach 10 s
  SIGKILL).
