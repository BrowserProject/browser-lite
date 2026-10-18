# web/

Die Browser-Oberflaeche: schlichtes HTML, CSS und JavaScript (ES-Module), ohne Build-Schritt.

| Datei | Inhalt |
| --- | --- |
| `index.html`, `style.css` | Tabs, Werkzeugleiste, Seitenbereich |
| `app.js` | Start der Engine, Tabs, Eingabe, Uploads, Downloads, Drucken, Kontextmenue, Tastenkuerzel |
| `watchdog.js` | Absturz (abort, OOM, Trap) und Haengen der Engine: Meldung und Neustart mit der Sitzung |
| `transport.js` | Wisp-Client: die TCP-Verbindungen der Engine ueber das Relay, Verbindungsstand fuer `navigator.onLine`, erkennt tote Verbindungen |
| `library.js` | Sitzung, Verlauf, Lesezeichen, Downloads, Seitenpanel |
| `profile.js` | Profil auf dem Server: Cookies, localStorage, kleine IndexedDBs und prefs, Abgleich |
| `settings.js` | Einstellungen (Seite ueber dem Browser), Geraet, User-Agent, Sprache, Zeitzone beim Start |
| `pickers.js` | Liste von `<select>`, Farbe, Datum, Link-Adresse unten links |
| `devices.js` | Berechtigungen, Standort, Sensoren, Benachrichtigungen, Gamepads, Sprache, Touch, Host-Bruecke der Polyfills |
| `media.js`, `sw.js` | `<video>`/`<audio>` ueber ein verstecktes Video und den Service Worker, Picture-in-Picture |
| `audio.js`, `audio-worklet.js` | Ton der Engine (Web Audio) |
| `capture.js` | Kamera, Mikrofon und Bildschirm fuer die Seiten |
| `webrtc.js` | WebRTC der Seiten mit echtem Gegenstueck im Host |
| `util.js` | gemeinsame Helfer (Speicher, Token, Base64, Fehler, Groessen, Neuladen der Oberflaeche ohne beforeunload) |
| `serve.mjs` | Entwicklungs-Server mit COOP/COEP, mit `PROFILE_DIR` auch das Profil |

Lokal: `npm run build && node web/serve.mjs 8080`, dann `http://localhost:8080/?relay=ws://localhost:5001/wisp/`
([docs/build.md](../docs/build.md)). Fuer den Server packt `tools/package-site.sh` alles mit
Versionsnummer zusammen.

## Profil

Cookies, localStorage und IndexedDB der Seiten liegen im OPFS des Host (`/data` der Engine).
Vor dem Start der Engine holt `profile.js` das Profil vom Server (`POST /profile/open`,
packages/server/README.md) und legt es ins OPFS, danach laedt es Geaendertes hoch: alle 2 s, nach dem
Verstecken, versteckt alle 30 s. Im Profil sind `cookies.db`, die `.localstorage`-Dateien und
die Ordner der IndexedDBs, ausser `cookies.db` nur bis zur Grenze pro Datenbank (Standard 256 KB,
in den Einstellungen). Groessere, Cache API, Service Worker und die Dateien der Seiten bleiben
als Cache auf dem Geraet, ebenso Verlauf und Sitzung. Die Datei `profile-id` im OPFS sagt, welches
Profil darin liegt: ein anderes (neues Geraet, zurueckgesetzt) leert das OPFS zuerst. Was vor
dem Schliessen nicht mehr hochgeladen wurde, laedt der naechste Start vorher nach, solange kein
anderes Geraet das Profil inzwischen geoeffnet hat (`localStorage['bl-profile-sync']`). Geht
das nicht, bleibt es auf dem Geraet und geht spaeter hoch, statt vom Server ueberschrieben zu
werden.

Einstellungen, Lesezeichen und Berechtigungen sind die prefs des Profils (`prefs()`,
`savePrefs()`), mit einer Kopie in `localStorage['bl-profile-prefs']` fuer den Start ohne Server.
Was nicht auf den Server kam, gilt beim naechsten Start mit Server von hier.
Oeffnet ein anderes Geraet das Profil, antwortet der Server diesem mit 409: der Abgleich stoppt,
ein Hinweis bietet "Neu laden" (uebernimmt das Profil wieder). Ohne Server laeuft alles lokal
weiter, ein zweiter Tab der Oberflaeche (ohne die Sperre `bl-data`) hat kein Profil. Den Token
nimmt `profile.js` wie das Relay der eigenen Seite (`?token=`). Hintergrund:
[docs/profil.md](../docs/profil.md).

Geraet, User-Agent, Sprachen, Zeitzone (`ENV.TZ`), Farbschema, Standard-Zoom, JavaScript, Bilder
und Global Privacy Control gelten ab dem Start der Engine (`settings.js`, "Jetzt neu starten").
Ein Mobilgeraet (iPhone, iPad) hat Groesse und Pixeldichte des Geraets, Touch, einen groben
Zeiger ohne Hover, die Maus tippt. Das iPad meldet sich wie echtes iPadOS als Mac. Mit "Tabs
beim Start wiederherstellen" bleiben die Sitzungs-Cookies (`BL_KEEP_SESSION_COOKIES=1`), nach
"Jetzt neu starten" immer. Die Einstellungen sind ein modaler `<dialog>`, Websitedaten loeschen
und Profil zuruecksetzen gehen nur im Tab mit dem Profil.

## URL-Parameter

- `?url=...` oeffnet diese Adresse statt der letzten Sitzung.
- `?relay=...` nimmt ein anderes Relay, nur fuer diesen Browser-Tab (sessionStorage). Ein leeres
  `?relay=` nimmt wieder das Relay der eigenen Seite (`/wisp/`).
- `?token=...` speichert den Zugangs-Token fuer genau das Relay, das gerade gilt. Ein anderes
  Relay bekommt ihn nie.
- `?env=JSC_verifyGC=1,BL_DEBUG=1` setzt zum Testen Umgebungsvariablen der Engine, nur `BL_*`,
  `JSC_*` und `FC_*`, nie `BL_EXTRA_CA`. Eine eigene CA kommt nur aus
  `localStorage['bl-extra-ca']` oder `window.__blExtraCA`.
- `?debug=1`, `?gpu=0`, `?compositing=0`, `?httpcache=0`, `?safepointgc=0`, `?fcdebug=1`:
  Schalter zur Fehlersuche.

## Absturz und Haengen

Eine Engine fuehrt alle Tabs. Bricht sie ab (`Module.onAbort`, WASM-Trap, Fehler aus einem
ihrer Threads), zeigt `watchdog.js` eine Meldung mit "Neu starten". Die Sitzung wird danach nicht
mehr gespeichert, der Neustart bringt den letzten guten Stand zurueck. Stuerzt sie innerhalb
einer Minute wieder ab, laden die Tabs nach dem Neustart erst beim Anklicken.

Haengen: auf Laden, Neu laden, Verlauf wiederherstellen und Suchen antwortet die Engine immer,
`app.js` ruft davor `expectAnswer()`. Kommt danach 10 s lang gar nichts von ihr, steckt ihr
Thread fest, und es gibt "Warten" oder "Neu starten" (dann laden die Tabs erst beim Anklicken).
Nach Klicks und Tasten schickt `app.js` eine Marke (`inputSent`), die der Engine-Thread nach der
Eingabe in seinem Speicher ablegt; bleibt sie 10 s zurueck, kommt dieselbe Meldung. Die Zeit in
einem Dialog der Seite zaehlt nicht.
Skripte einer Seite, die die Engine 30 s blockieren, bricht die Engine selber ab
(`?env=BL_SCRIPT_TIMEOUT=<s>`, 0 = aus).
