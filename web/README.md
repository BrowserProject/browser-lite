# web/

Die Browser-Oberflaeche: schlichtes HTML, CSS und JavaScript (ES-Module), ohne Build-Schritt.

| Datei | Inhalt |
| --- | --- |
| `index.html`, `style.css` | Tabs, Werkzeugleiste, Seitenbereich |
| `app.js` | Start der Engine, Tabs, Eingabe, Uploads, Downloads, Drucken, Kontextmenue, Tastenkuerzel |
| `watchdog.js` | Absturz (abort, OOM, Trap) und Haengen der Engine: Meldung und Neustart mit der Sitzung |
| `transport.js` | Wisp-Client: die TCP-Verbindungen der Engine ueber das Relay, Verbindungsstand fuer `navigator.onLine` |
| `library.js` | Sitzung, Verlauf, Lesezeichen, Downloads, Einstellungen, Seitenpanel |
| `pickers.js` | Liste von `<select>`, Farbe, Datum, Link-Adresse unten links |
| `devices.js` | Berechtigungen, Standort, Sensoren, Benachrichtigungen, Gamepads, Sprache, Touch, Host-Bruecke der Polyfills |
| `media.js`, `sw.js` | `<video>`/`<audio>` ueber ein verstecktes Video und den Service Worker, Picture-in-Picture |
| `audio.js`, `audio-worklet.js` | Ton der Engine (Web Audio) |
| `capture.js` | Kamera, Mikrofon und Bildschirm fuer die Seiten |
| `webrtc.js` | WebRTC der Seiten mit echtem Gegenstueck im Host |
| `util.js` | gemeinsame Helfer (Speicher, Base64, Fehler) |
| `serve.mjs` | Entwicklungs-Server mit COOP/COEP |

Lokal: `node web/serve.mjs 8080`, dann `http://localhost:8080/?relay=ws://localhost:5001/wisp/`
([docs/build.md](../docs/build.md)). Fuer den Server packt `tools/package-site.sh` alles mit
Versionsnummer zusammen.

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
Skripte einer Seite, die die Engine 30 s blockieren, bricht die Engine selber ab
(`?env=BL_SCRIPT_TIMEOUT=<s>`, 0 = aus).
