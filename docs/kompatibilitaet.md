# Kompatibilitaet mit echten Seiten

Die Liste der Seiten steht in `tests/e2e/sites.txt`. CI laedt sie im Job
`kompatibilitaet` (blockiert nichts, weil fremde Server mal nicht gehen) und schreibt
eine Tabelle in die Zusammenfassung des Laufs. Die Screenshots sind im Artefakt
`kompatibilitaet`, benannt nach Host und Pfad (`build/sites/<host>_<pfad>.png`, z.B.
`www.google.com_maps.png`).

## Stand 2026-10-16 (lokal)

Alle 54 Seiten laden ohne Absturz (eBay zeigt seine Sperrseite). Getestet ueber das lokale
Relay, Screenshot kurz nach dem Laden. "ok" heisst: laedt, kein Absturz, Seite sieht im
Screenshot aus wie in Chrome (bis auf noch ladende Teile). Viele Seiten zeigen zuerst ihren
Cookie-Dialog, weil der Test ohne gespeicherte Daten startet.

| Seite | Status | Bemerkung |
|---|---|---|
| Google Suche, Google Maps, Google Translate | ok | zuerst die Zustimmungsseite von Google. Maps zeichnet die Karte mit WebGL |
| YouTube | ok | zuerst die Zustimmungsseite, Startseite ohne Login leer ("Try searching"), wie in Chrome |
| Wikipedia, Bing, DuckDuckGo, Yahoo | ok | |
| X, Instagram, Facebook, LinkedIn | ok | Login-Seiten |
| Reddit, old.reddit | ok | Reddit rechnet zuerst eine JavaScript-Pruefung, dann kommt die Startseite |
| TikTok | ok | Video laeuft |
| Twitch, Discord, Netflix, PayPal | ok | |
| Spotify Web Player | ok | braucht laenger bis zum Inhalt |
| GitHub, Stack Overflow, MDN, W3Schools, Python-Doku, Hacker News | ok | |
| npm, Medium | ok | Cloudflare kann bei Rechenzentrums-IPs das Kaestchen "Verify you are human" zeigen, die Pruefung kommt mit WebAssembly bis dorthin |
| Apple, Microsoft, Amazon | ok | |
| eBay | gesperrt | Fehlerseite "Something went wrong on our end": eBay sperrt Rechenzentrums-IPs. Liegt an der IP des Relays, nicht an der Engine |
| CNN, BBC, NYTimes, Spiegel, SRF | ok | |
| weather.com | ok | viel JavaScript, laedt von allen Seiten am laengsten |
| 20min, Blick, NZZ, Galaxus, Zalando, Ricardo | ok | |
| Booking, IMDb, SBB | ok | Bot-Pruefung von AWS WAF rechnet durch (WebCrypto mit OpenSSL 3, Patch 0010) und laedt die echte Seite neu |
| OpenStreetMap | ok | Karte |
| three.js-Beispiel (WebGL), Squoosh | ok | |
| sql.js-Demo (SQLite als WebAssembly im Worker) | ok | Abfrage liefert das richtige Ergebnis |

## Messlatte gegen Chromium

`tests/e2e/parity-test.mjs` laedt `tests/engine/features.html` (280 Pruefungen) im Host-Chromium
und im browser-lite. Stand 2026-10-16: **257 von 280 wie Chromium (91.8 %)**. Es fehlen:

- was WebKit nicht hat: Layout-Shift- und Long-Animation-Frame-Eintraege, `interpolate-size`,
  Streams als Request-Body, Storage Buckets, Background Sync, `document.featurePolicy`,
  IdleDetector
- was eigenen Netz- oder Engine-Code braucht: WebTransport (QUIC ueber das Relay), JSPI, MSE in
  Workern (Compile-Schalter und threadsichere MSE-Klassen, #121)
- bewusst Weggelassenes: WebAuthn, Credential Management, Payment Request, Web
  MIDI/USB/HID/Serial, WebXR, EME, WebGPU, Push, `userAgentData` (#90)

Dafuer kann browser-lite schon `Math.sumPrecise`, Temporal und `ReadableStream.from`, die das
Host-Chromium noch nicht hat. `toLocaleString` fuer de-CH: seit CLDR 48 ist der
Tausender-Trenner `'` statt `’`, die Pruefung nimmt beides. Die Liste der Unterschiede steht
im CI-Lauf (Schritt "Messlatte").

## Bekannte Grenzen

- Manche Seiten sperren Rechenzentrums-IPs (eBay, Cloudflare zeigt dann ein Kaestchen zum
  Anklicken). Ein Relay in einem Rechenzentrum und die CI-Runner haben so eine IP. Abhilfe
  spaeter mit WireGuard ueber einen anderen Anschluss.
- JavaScript ist ohne JIT langsamer (CLoop), grosse Seiten brauchen 10 bis 60 s.
- WebAssembly mit geteiltem Speicher (Threads) und JSPI gehen nicht, `validate()` sagt fuer
  solche Module false. Seiten nehmen dann meist eine Variante ohne Threads bzw. mit Asyncify.
  memory64 und mehrere Speicher gehen. Ein Speicher hat hoechstens 2 GB, Aufrufe zwischen JS
  und WebAssembly gehen bis 64 Ebenen tief (der Stack des Browsers lief in Chrome bei ca. 125
  ueber, gemessen nur in Chrome, 64 ist Reserve, keine Garantie).
- CSS Paint Worklet: das Skript wird klassisch ausgewertet, Module mit `import`/`export`
  lehnen mit `AbortError` ab.
- DRM (EME) gibt es nicht, Netflix & Co. spielen keine geschuetzten Videos ab.
