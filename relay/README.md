# relay/

Der Server im Container (`Dockerfile` im Hauptordner): Wisp-Relay (TCP ueber WebSocket,
optional mit Token), mit `SITE_DIR` die fertige Seite (`tools/package-site.sh`) mit den
Headern fuer SharedArrayBuffer (COOP/COEP), vorkomprimierten Dateien (.br/.gz) und ETag
(304 beim Neuladen), und mit `PROFILE_DIR` das Browser-Profil (`profile.mjs`, unten).
`static.mjs` (Auslieferung und Parsen der URL) und `profile.mjs` nutzt auch der
Entwicklungs-Server `web/serve.mjs`. `wisp.mjs` sind die Wisp-Verbindungen (wisp-js mit
eigenen TCP-Sockets): sie pruefen jede Adresse und schicken den Grund, warum ein Stream nicht
aufgeht.

Betrieb und Deploy: [deploy/README.md](../deploy/README.md). Tests: `tests/relay/relay-test.mjs`,
`tests/relay/profile-test.mjs`.

## Profil

Der Server hostet genau ein Browser-Profil: Cookies, localStorage und kleine IndexedDBs (Pfade
wie in `/data` der Engine) und die prefs der Oberflaeche (settings, bookmarks, permissions).
Ablage unter `PROFILE_DIR`: `profile.json` (id, aktive Session, Geraet), `files/<pfad>`,
`prefs/<name>.json`, `tmp/`. Jede Datei wird atomar geschrieben (tmp, fsync, rename). Ist der
Ordner nicht schreibbar, laeuft der Server trotzdem und `/profile/` antwortet 503. Hintergrund:
[docs/profil.md](../docs/profil.md).

| Anfrage | |
| --- | --- |
| `POST /profile/open` `{ "device" }` | nur mit `Content-Type: application/json` (sonst 415), neue Session, die ab jetzt als einzige schreibt. Antwort (gzip wenn erlaubt): `u32 LE` Laenge des Kopfes, Kopf JSON `{ id, session, created, prefs, files: [{ path, size }] }`, dann alle Dateien hintereinander |
| `PUT /profile/files/<pfad>` | rohe Bytes, 204 |
| `DELETE /profile/files/<pfad>` | 204, auch wenn schon weg, leere Ordner gehen mit |
| `PUT /profile/prefs/<name>` | JSON (hoechstens 1 MB), 204 |
| `POST /profile/reset` `{ "all" }` | loescht Dateien und permissions, mit `all` auch settings und bookmarks, neue id, 204 |
| `GET /profile/info` | `{ id, created, updated, device, opened, maxBytes, bytes, files: [{ path, size, modified }], cookies }`, `cookies` pro Domain mit `node:sqlite`, sonst (oder ohne echte Tabelle `Cookie`) null |

- Schreiben nur mit `X-Profile-Session` der aktiven Session, sonst 409 `{ "reason": "taken" }`
  (anderes Geraet hat geoeffnet) oder `{ "reason": "reset" }` (zurueckgesetzt). Die Session
  steht in `profile.json`, gilt also auch nach einem Neustart.
- Erlaubte Pfade (sonst 400): `cookies.db`, `localstorage/<name>.localstorage`,
  `indexeddb/v1/<a>/<b>/<datei>`, `indexeddb/v1/<a>/<b>/<c>/<datei>`. Namen nicht leer, ohne
  `/`, `\` und Nullbyte, nicht mit `.` beginnend, hoechstens 255 Bytes.
- Eine Datei hoechstens 32 MB (413, auch beim Lesen eines Bodys ohne Content-Length), das ganze
  Profil hoechstens `PROFILE_MAX_MB` (Standard 64, sonst 507). Andere Dateien in `files/`
  werden nie verschickt oder gezaehlt. `info` oeffnet `cookies.db` read-only und immutable
  (keine `-shm`/`-wal`), ohne Code aus dem Schema.
- Gegen DNS-Rebinding nur mit `Host` als IP-Adresse, `localhost` oder einem Namen aus
  `PROFILE_HOSTS` (mit Komma, `.ts.net` passt auf alle Namen, die so enden), sonst 403. Gegen
  CSRF ist kein Aufruf ein einfacher Cross-Site-Request (CORS gibt es nicht): `open` braucht
  JSON, die anderen schreibenden Aufrufe PUT/DELETE oder `X-Profile-Session`.
- Mit `RELAY_TOKEN` nur mit `Authorization: Bearer <token>` (sonst 403). Die Dateien liegen
  unverschluesselt auf dem Server.

## Sicherheit

- Mit `RELAY_TOKEN` lehnt das Relay jede Verbindung ohne gueltigen Token ab (403), auch
  `/profile/`. Ohne ist es offen, dann nur intern betreiben.
- Nur oeffentliche Unicast-Adressen (`ipaddr.js`, `range() === 'unicast'`, IPv4-mapped IPv6
  wie `::ffff:127.0.0.1` wird vorher in IPv4 umgewandelt). Gesperrt sind also Loopback,
  private Netze, Link-Local, ULA (`fd00::/8`), NAT64 usw. Jede Adresse, mit der das Relay
  verbindet, prueft sein Socket (`wisp.mjs`) direkt davor (kein DNS-Rebinding zwischen
  Pruefen und Verbinden). Ein Name kann mehrere Adressen haben: verbunden wird nur zu den
  geprueften, IPv6 und IPv4 abwechselnd wie in einem Browser (`autoSelectFamily`).
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
  SIGKILL). Das Profil wird atomar geschrieben, ein Abbruch laesst die alte Datei stehen.
