# Kompatibilitaet mit echten Seiten

Die Liste der Seiten steht in `tests/e2e/sites.txt`. CI laedt sie im Job
`kompatibilitaet` (blockiert nichts, weil fremde Server mal nicht gehen) und schreibt
eine Tabelle in die Zusammenfassung des Laufs. Die Screenshots sind im Artefakt
`kompatibilitaet`.

## Stand 2026-10-14 (lokal, nach WebRTC/PiP/MediaRecorder)

46 von 54 Seiten laden. Nicht geladen: Reddit, old.reddit, Stack Overflow, BBC, NYTimes und Spiegel
(Netz-Sperre der Test-Umgebung, in CI ok), OpenStreetMap ("This website is under heavy load", Schutz
gegen Rechenzentrums-IPs) und weather.com (Titel da, `load` erst nach dem Zeitlimit von 120 s).

## Stand 2026-10-12 (lokal, Engine mit WebGL)

Getestet ueber das lokale Relay, 6 s nach dem Laden ein Screenshot. "ok" heisst: laedt,
kein Absturz, Seite sieht im Screenshot aus wie in Chrome (bis auf noch ladende Teile).

| Seite | Status | Bemerkung |
|---|---|---|
| Google Suche, Google Maps, Google Translate | ok | Maps zeichnet die Karte mit WebGL |
| YouTube | ok | Startseite ohne Login leer ("Try searching"), wie in Chrome |
| Wikipedia, Bing, DuckDuckGo, Yahoo | ok | |
| X, Instagram, Facebook, LinkedIn | ok | Login-Seiten. X stuerzte ab und zu ab (WebKit-Fehler bei der Stack-Grenze im C-Loop, Patch 0022) |
| TikTok | ok | Video laeuft |
| Twitch, Discord, Netflix, PayPal | ok | |
| Spotify Web Player | ok | braucht laenger als 6 s bis zum Inhalt |
| GitHub, Stack Overflow, MDN, W3Schools, Python-Doku | ok | |
| Apple, Microsoft, Amazon, eBay | ok | Microsoft und eBay ca. 25 s bis geladen |
| CNN, weather.com | ok | weather.com 50 bis 80 s bis geladen (viel JavaScript), knapp am Zeitlimit des Tests (120 s) |
| Blick, NZZ, Galaxus, Zalando, Ricardo | ok | |
| three.js-Beispiel (WebGL) | ok | |
| npm, Medium | teilweise | Cloudflare-Pruefung: seit WebAssembly geht, kommt das Kaestchen "Verify you are human" (bei Rechenzentrums-IPs normal), vorher blieb sie bei "Verifying" haengen |
| sql.js-Demo (SQLite als WebAssembly im Worker) | ok | Abfrage liefert das richtige Ergebnis |
| Squoosh | ok | Startseite |
| NYTimes, Spiegel | ok | in CI getestet |
| Reddit, eBay | gesperrt | Sperren Rechenzentrums-IPs ("blocked by network security" bzw. Fehlerseite). Liegt an der IP des Relays, nicht an der Engine |
| Booking, IMDb, SBB | ok | Bot-Pruefung von AWS WAF: scheiterte an WebCrypto (AES-GCM ging mit OpenSSL 3 nicht, Patch 0010), jetzt rechnet sie durch und laedt die echte Seite neu |

## Messlatte gegen Chromium

`tests/e2e/parity-test.mjs` laedt `tests/engine/features.html` (277 Pruefungen) im Host-Chromium
und im browser-lite. Stand 2026-10-12: **206 von 277 wie Chromium (74 %)**. Es fehlen vor allem
Service Worker, SharedWorker, Cache API und Speicher-APIs, WebRTC/WebCodecs/Kamera,
Geraete-APIs (Touch, Gamepad, Geolocation, Benachrichtigungen), OffscreenCanvas und variable
Schriften. Die Liste der Unterschiede steht im CI-Lauf (Schritt "Messlatte").

## Bekannte Grenzen

- Manche Seiten sperren Rechenzentrums-IPs (Reddit, eBay, Cloudflare zeigt dann ein
  Kaestchen zum Anklicken). Das Relay auf einem VPS hat so eine IP. Abhilfe spaeter mit
  WireGuard ueber einen anderen Anschluss.

- JavaScript ist ohne JIT langsamer (CLoop), grosse Seiten brauchen 10 bis 60 s.
- WebAssembly mit geteiltem Speicher (Threads) geht noch nicht. Seiten nehmen dann meist
  eine Variante ohne Threads.
- DRM (EME) gibt es nicht, Netflix & Co. spielen keine geschuetzten Videos ab.
