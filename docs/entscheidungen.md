# Entscheidungen

Hier steht was wir entschieden haben und kurz warum. Neue Entscheidungen unten anhaengen.

| # | Thema | Entscheid | Warum |
|---|---|---|---|
| 1 | Engine | WebKit, WPE-Release-Stand, eigener `PORT=Wasm` | WebKit ist von den grossen Engines am besten portierbar (CLoop, curl-Backend, generischer RunLoop) |
| 2 | Prozessmodell | Single-process in einem Web Worker | WebKit2-IPC in WASM nachbauen waere sehr viel Arbeit und langsamer (Kopieren statt Shared Memory) |
| 3 | Port-Basis | Aufbau wie PlayStation-Port, Grafik wie WPE (Skia) | PlayStation = curl + RunLoopGeneric + statisch, ohne GLib/libsoup. Ein abgespecktes WPE muesste GLib/soup/WebKit2 rausloesen |
| 4 | JS | JSC CLoop, kein JIT | WASM kann keinen normalen JIT. CLoop ist ein offizieller, getesteter Modus |
| 5 | Speichermodell | wasm32 (kein Memory64) | Memory64 ist deutlich langsamer. 4 GB reichen wenn wir Features trimmen |
| 6 | Grafik | Skia, zuerst CPU, dann WebGL2 | Cairo wird in WebKit nicht mehr unterstuetzt. Skia laeuft nachweislich in WASM (CanvasKit) |
| 7 | Netzwerk | Wisp ueber WebSocket zum eigenen Relay | Browser koennen kein rohes TCP/UDP, fetch() scheitert an CORS. Wisp kann TCP und UDP (wichtig fuer WireGuard spaeter) |
| 8 | TLS | OpenSSL im WASM | Ende-zu-Ende verschluesselt, Relay sieht keinen Inhalt. WebCore curl-Backend braucht die OpenSSL-API |
| 9 | Threads | Emscripten pthreads, kein Asyncify | Asyncify macht den Code viel groesser. JSPI evtl. spaeter |
| 10 | Zielbrowser | Chrome/Chromebook zuerst, dann Firefox, Safari optional | Wunsch vom Projekt, Chrome hat die beste WASM-Unterstuetzung |
| 11 | WebKit holen | Skript mit shallow + sparse + blobless Fetch statt Git-Submodule | Submodule wuerde beim Klonen GBs an Tests ziehen. So sind es ca. 300 MB Download |
| 12 | Build | GitHub Actions mit Docker-Toolchain-Image | Repo ist public, gleiche Umgebung lokal und in CI |
| 13 | Referenz | WebkitWasm (theogbob) nur als Referenz, kein Fork | Wir wollen eine saubere, reproduzierbare Basis. Lizenz ist BSD-2-Clause, Uebernahmen sind mit Copyright-Hinweis erlaubt |
| 14 | Lizenz | BSD-2-Clause fuer eigenen Code | Kompatibel mit WebKit (LGPL/BSD) und mit der Referenz |
