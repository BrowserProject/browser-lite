# Kompatibilitaet mit echten Seiten

Die Liste der Seiten steht in `tests/e2e/sites.txt`. CI laedt sie im Job
`kompatibilitaet` (blockiert nichts, weil fremde Server mal nicht gehen) und schreibt
eine Tabelle in die Zusammenfassung des Laufs. Die Screenshots sind im Artefakt
`kompatibilitaet`.

## Stand 2026-10-12 (lokal, Engine mit WebGL)

Getestet ueber das lokale Relay, 6 s nach dem Laden ein Screenshot. "ok" heisst: laedt,
kein Absturz, Seite sieht im Screenshot aus wie in Chrome (bis auf noch ladende Teile).

| Seite | Status | Bemerkung |
|---|---|---|
| Google Suche, Google Maps, Google Translate | ok | Maps zeichnet die Karte mit WebGL |
| YouTube | ok | Startseite ohne Login leer ("Try searching"), wie in Chrome |
| Wikipedia, Bing, DuckDuckGo, Yahoo | ok | |
| X, Instagram, Facebook, LinkedIn | ok | Login-Seiten |
| TikTok | ok | Video laeuft |
| Twitch, Discord, Netflix, PayPal | ok | |
| Spotify Web Player | ok | braucht laenger als 6 s bis zum Inhalt |
| GitHub, Stack Overflow, MDN, W3Schools, Python-Doku | ok | |
| Apple, Microsoft, Amazon, eBay | ok | Microsoft und eBay ca. 25 s bis geladen |
| CNN, weather.com | ok | weather.com ca. 60 s bis geladen (viel JavaScript) |
| Blick, NZZ, Galaxus, Zalando, Ricardo | ok | |
| three.js-Beispiel (WebGL) | ok | |
| npm, Medium | teilweise | Cloudflare-Pruefung: seit WebAssembly geht, kommt das Kaestchen "Verify you are human" (bei Rechenzentrums-IPs normal), vorher blieb sie bei "Verifying" haengen |
| sql.js-Demo (SQLite als WebAssembly im Worker) | ok | Abfrage liefert das richtige Ergebnis |
| Squoosh | ok | Startseite |
| NYTimes, Spiegel | ok | in CI getestet |
| Reddit, eBay | gesperrt | Sperren Rechenzentrums-IPs ("blocked by network security" bzw. Fehlerseite). Liegt an der IP des Relays, nicht an der Engine |
| Booking, IMDb, SBB | offen | In CI (noch ohne WebAssembly) leere Seite ohne Titel, vermutlich eine Bot-Pruefung. Lokal im Test-Netz gesperrt |

## Bekannte Grenzen

- Manche Seiten sperren Rechenzentrums-IPs (Reddit, eBay, Cloudflare zeigt dann ein
  Kaestchen zum Anklicken). Das Relay auf einem VPS hat so eine IP. Abhilfe spaeter mit
  WireGuard ueber einen anderen Anschluss.

- JavaScript ist ohne JIT langsamer (CLoop), grosse Seiten brauchen 10 bis 60 s.
- WebAssembly mit geteiltem Speicher (Threads) geht noch nicht. Seiten nehmen dann meist
  eine Variante ohne Threads.
- DRM (EME) gibt es nicht, Netflix & Co. spielen keine geschuetzten Videos ab.
