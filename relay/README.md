# relay/

Der Server im Container (`Dockerfile` im Hauptordner): Wisp-Relay (TCP ueber WebSocket,
optional mit Token) und, mit `SITE_DIR`, die fertige Seite (`tools/package-site.sh`) mit den
Headern fuer SharedArrayBuffer (COOP/COEP), vorkomprimierten Dateien (.br/.gz) und ETag
(304 beim Neuladen). `static.mjs` (Auslieferung und Parsen der URL) nutzt auch der
Entwicklungs-Server `web/serve.mjs`. `wisp.mjs` sind die Wisp-Verbindungen (wisp-js mit
eigenen TCP-Sockets): sie pruefen jede Adresse und schicken den Grund, warum ein Stream nicht
aufgeht.

Betrieb und Deploy: [deploy/README.md](../deploy/README.md). Test: `tests/relay/relay-test.mjs`.

## Sicherheit

- Mit `RELAY_TOKEN` lehnt das Relay jede Verbindung ohne gueltigen Token ab (403). Ohne ist
  es offen, dann nur intern betreiben.
- Nur oeffentliche Unicast-Adressen (`ipaddr.js`, `range() === 'unicast'`, IPv4-mapped IPv6
  wie `::ffff:127.0.0.1` wird vorher in IPv4 umgewandelt). Gesperrt sind also Loopback,
  private Netze, Link-Local, ULA (`fd00::/8`), NAT64 usw. Jede Adresse, mit der das Relay
  verbindet, prueft sein Socket (`wisp.mjs`) direkt davor (kein DNS-Rebinding zwischen
  Pruefen und Verbinden).
- Nur Ports 80, 443, 8080, 8443. Nur TCP-Streams, jeden anderen Typ (auch UDP, kommt mit
  WireGuard) lehnt `wisp.mjs` mit 0x48 ab.
- `RELAY_ALLOW_LOCAL=1` hebt Adress- und Port-Sperre auf, nur fuer Tests mit lokalen Servern.
- Pro Verbindung hoechstens 256 gleichzeitige Streams, davon 64 zum gleichen Ziel (Name und
  Port, Grund 0x49). Schliesst der Client einen Stream, ist auch der Socket zum Ziel zu, und
  pro Stream puffert das Relay hoechstens 128 Stuecke (danach liest es nicht weiter).
- Solange Streams offen sind und sonst nichts kommt, schickt das Relay alle 3 s ein CONTINUE
  auf Stream 0: daran sieht der Client auch bei langsamem Upload, dass es lebt.
- Gruende fuer gescheiterte Streams: 0x41 ungueltiges Ziel (leerer Name oder Port 0, so fragt
  der Client nach, ob die Verbindung lebt), 0x42 Name unbekannt, 0x43 keine Antwort, 0x44
  abgewiesen, 0x48 gesperrt, 0x49 gedrosselt, 0x4a Adresse nicht erreichbar (eigener Grund,
  nicht in Wisp).
- Das Relay loggt keine Inhalte (die sind sowieso TLS-verschluesselt).
- SIGTERM beendet sofort (Node ist PID 1 im Container, ohne Handler kaeme erst nach 10 s
  SIGKILL).
