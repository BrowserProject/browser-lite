# Stand und offene Punkte (17.10.2026)

Kurze Uebersicht, wo das Projekt gerade steht und was noch offen ist. Details zu
den einzelnen Punkten stehen in [entscheidungen.md](entscheidungen.md) (Nummern
#...), die Phasen in [roadmap.md](roadmap.md).

## Was laeuft

- WebKit (WebCore + JavaScriptCore mit CLoop-Interpreter) als WebAssembly in
  einem Tab, eigenes Netz ueber Wisp-Relay, TLS im WASM. Das Relay verbindet nur
  zu oeffentlichen Adressen und Web-Ports, hoechstens 64 Streams einer Verbindung
  zum gleichen Ziel (#178).
- Basis-Browser ohne Komfort-Funktionen (kein Passwort-Speicher, kein PDF-Viewer,
  #130): Tabs, Verlauf (auch `pushState`), Lesezeichen, Downloads, Zoom,
  Pinch-Zoom wie Chrome (nur die Ansicht, im Compositor-Thread), Suche auf der
  Seite. `mailto:`, `tel:` und andere Schemata gehen nach einem Klick an den
  Host-Browser.
- Strg + Rad geht wie in Chrome zuerst an die Seite, auch in iframes (Patch 0038): ruft
  ein wheel-Listener `preventDefault` (Karten, Editoren), zoomt nur die Seite selber. Ohne
  blockierenden Listener an der Stelle zoomt die Ansicht sofort, auch wenn das JS
  blockiert (#167).
- Tabs im Hintergrund und bei verdecktem Host-Tab sind fuer ihre Seiten versteckt
  (`visibilityState` hidden, kein rAF, keine CSS-Animationen, verschachtelte Timer und
  `setInterval` hoechstens 1/s, kein Malen, auch nicht im Compositor). Mit Ton laufen
  Ton und Timer weiter, ein stummes Video im PiP-Fenster laeuft auch, angehalten wird wie in
  Chrome nur Video ohne Tonspur (#170, Patch 0042). Wird der WASM-Speicher
  knapp, meldet die Engine das und die Oberflaeche verwirft Hintergrund-Tabs, solange es
  geht nicht die mit PiP-Fenster oder Eingaben (#171).
- Dialoge: beforeunload wie Chrome ("Website verlassen?" bzw. "Website neu laden?") beim
  Wegnavigieren, Neu laden und Schliessen, nur nach einer Benutzer-Aktion; ein
  Hintergrund-Tab kommt zum Fragen nach vorne, der Host-Tab fragt beim Schliessen selber,
  eine Seite, die in einer Schleife navigiert, fragt hoechstens zweimal (#168). `window.focus()` und `WindowClient.focus()` holen den Tab nach vorne, Popups haben
  Opener, Namen und Sandbox (#169). Unterdrueckte Dialoge zeigt ein Zeichen am Tab.
- Absturz und Haengen: die Oberflaeche zeigt es an, auch wenn ein Klick oder eine
  Taste 10 s ohne Antwort bleibt (#172), "Neu starten" stellt die Sitzung wieder her.
  Ein Skript, das die Engine laenger als 30 s blockiert, bricht der Watchdog ab
  (`BL_SCRIPT_TIMEOUT`, 0 = aus).
- Netzfehler: Fehlerseite wie Chrome mit dem Grund vom Relay (`ERR_NAME_NOT_RESOLVED`,
  `ERR_CONNECTION_REFUSED`, `ERR_CONNECTION_TIMED_OUT`, `ERR_ACCESS_DENIED`,
  `ERR_ADDRESS_UNREACHABLE`, `ERR_PROXY_CONNECTION_FAILED`, Zertifikat, TLS) und "Neu
  laden" unter der Adresse, die nicht ging, ohne Schloss in der Adressleiste; kommt die
  Verbindung wieder, laedt die Engine sie neu, ein Formular erst mit "Erneut senden" (#174,
  #175, Patch 0039). Eine halb offene Verbindung zum Relay erkennt der
  Transport und verbindet neu (#177). curl: hoechstens 64 Verbindungen, 6 pro Host (#176).
- GPU-Rastern (Skia ueber WebGL 2), Compositing mit eigenem Thread, asynchrones
  Scrollen, Blur und Schatten auf der GPU (gefilterte Ebenen werden
  wiederverwendet), CSS Paint Worklet. Nach einem GPU-Verlust malt die Engine auf
  der CPU weiter und kehrt auf die GPU zurueck, WebGL-Seiten bekommen
  `webglcontextlost` und `webglcontextrestored`.
- Medien (Video/Audio auch aus `blob:` und `data:`, MSE, WebCodecs, WebRTC,
  getUserMedia) ueber den Host-Browser.
- WebAssembly der Seiten in der WASM-Engine des Host, auch memory64, table64 und
  mehrere Speicher (hoechstens 2 GB pro Speicher, 64 verschachtelte Aufrufe).
  `memory.grow` zieht mit einem Viertel Reserve um (hoechstens 96 MB, #184). Web Worker der
  Seiten laufen aus dem Event-Loop des Host (Patch 0041): Speicher frueherer Instanzen
  wird auch in langlebigen Workern frei, FinalizationRegistry und Timer von JSC laufen
  dort (#183).
- Service Worker mit Update im Hintergrund, Navigation Preload (auch aus dem HTTP-Cache,
  #182), Benachrichtigungen und `clients.openWindow()` nach `notificationclick`.
- Speicher: WasmFS, `/data` im OPFS (#142, nur ein Host-Tab besitzt es), HTTP- und
  Bytecode-Cache in der Cache API (#70, #135), Inhalte der Cache API der Seiten als
  eigene Dateien. Ohne Platz im OPFS des Host bekommen die Seiten im OPFS
  `QuotaExceededError` (#166). `navigator.onLine` folgt der Verbindung zum Relay.
- IndexedDB: hoechstens 256 MB pro Ursprung nur fuers Schreiben (`QuotaExceededError`,
  Geloeschtes gibt Platz frei, `navigator.storage.estimate()` meldet Grenze und Platz),
  Oeffnen, Lesen und Loeschen gehen auch ueber der Grenze; zu grosse Dateien laedt das VFS
  nicht, sie lassen sich nur loeschen (#179, Patch 0040). SQLite kommt als eine Datei mit
  dem WAL darin auf die Platte, 1 s nach einer Aenderung und beim Schliessen des Tabs (#180).
  Uploads liest der Engine-Thread in Stuecken direkt ins OPFS (#181).
- Messlatte: 257 von 280 Funktionen wie Chromium (`tests/e2e/parity-test.mjs`).
- Tests: gemeinsames Geruest fuer die e2e-Tests (`tests/e2e/harness.mjs`, auch
  parallel), dazu Grenzen (`limits.html`), Watchdog (`hang.html`), echte Abstuerze
  (`BL_TEST_HOOKS=1`), Netzfehler (falsche Zertifikate, DNS, Relay-Neustart, Relay als
  Attrappe), Hintergrund-Tabs (`background-test.mjs`) und ein langer Lauf
  (`soak-test.mjs`: 200 Navigationen, 30 Tabs, Dokumente und Speicher bleiben begrenzt).
- CI und Deploy bei jedem Push auf `main` (Stand in GitHub Actions). Der Deploy
  laeuft ueber den Self-hosted Runner auf den eigenen Proxmox-Server (LXC), auf dem
  Runner laeuft keine fremde Action. Actions sind per Commit gepinnt, der Lint prueft die
  Regeln aus AGENTS.md (`tools/check-style.sh`, #185).

## Messwerte (lokal, erster Besuch)

Aus `tests/e2e/site-test.mjs` (Spalten "erstes Layout" seit #144, "erstes Bild" seit #164),
Zeit ab Start der Oberflaeche, je 3 Laeufe am 16.10.2026:

| Seite | Erstes Layout | Erstes Bild | Geladen |
|---|---|---|---|
| YouTube | 2.5-3.1 s | 2.5-5.7 s | 5.1-6.7 s |
| GitHub | 3.1-4.3 s | 3.4-4.6 s | 2.8-3.3 s |
| weather.com | 2.3-2.8 s | 2.4-3.0 s | 5.2-6.4 s (Inhalt wechselt) |
| NZZ | 3.4 s | - | 14-21 s |
| CNN | 3.1-3.8 s | 3.2-4.0 s | 21-26 s |
| Wikipedia (Schweiz) | 3.9-4.6 s | 4.1-4.8 s | 7.3-8.4 s |
| Twitch | 6.7 s | - | 8-34 s (Inhalt wechselt) |
| 20min | 3.7-8.6 s | 3.8-8.9 s | 27-29 s |

## Offen: Leistung (nach Nutzen)

1. **Erstes Bild auf schweren Seiten**: meist 0.1-0.3 s nach dem ersten Layout (#164).
   Faellt das erste Layout in ein langes Skript (20min: erzwungene Layouts, YouTube:
   2.6-3 s Skript gleich danach), kommt das Bild erst nach dem Skript. Der HTML-Parser
   arbeitet lange Stuecke (1-1.5 s) ohne Pause, eine kuerzere Zeitgrenze brachte nichts
   ohne Kosten (#186). Aufgaben anderer Threads warten unter Last bis 3.7 s im Postfach
   von Emscripten, Abholen bei jedem Durchgang brachte nichts. Zu pruefen: mit
   `?env=...` (egal welcher Wert) kam das erste Bild auf YouTube in 32 von 36 Laeufen
   unter 3.5 s, ohne in 10 von 24 (#186). Twitch laedt zweigeteilt (6-7 s oder ca. 20 s).
2. **Kompilieren beim ersten Aufruf** (weather.com ca. 11 s Parser + Bytecode):
   beim zweiten Besuch hilft der Bytecode-Cache (#135), beim ersten nicht.
3. **Interpreter-Eigenzeit** (CLoop, 15-21 % auf JS-lastigen Seiten): nur mit
   grossem Umbau deutlich schneller (Interpreter mit Tail-Calls oder ein JIT nach
   WASM). Kleine Caches sind gemacht (#143), polymorpher Cache lohnt laut Zaehlung
   nicht.
4. **Erzwungenes Flex/Grid-Layout** durch JS (20min ca. 6.5 s, #141): kein
   billiger Fix gefunden.
5. **GC** 5-7 % auf JS-lastigen Seiten (#60, #122).

## Offen: Funktionen

- Login mit Profil auf dem Server (Cookies, localStorage, kleine IndexedDB), Plan in
  [profil.md](profil.md).
- Pinch-Zoom: `visualViewport`-Events kommen erst am Ende der Geste (jeder
  Zwischenstand wuerde alle Kacheln neu malen). Zwei Finger warten auf die
  touchstart-Antwort der Seite, auch ohne blockierende Touch-Listener (braucht
  Touch-Event- und touch-action-Regions in WebKit, also einen vollen Neubau). Die
  Uebernahme am Ende kostet einen Style- und Layout-Durchlauf.
- Hintergrund-Tabs: `scheduler.yield()` und `postTask` laufen ueber `setTimeout` und sind
  versteckt gedrosselt wie verschachtelte Timer (Chrome drosselt sie nicht; ueber
  MessageChannel kamen sie spaeter als ein 5-ms-Timer und die Reihenfolge brach). Stumme
  Videos halten versteckt an wie in Safari, ausser nach PiP (Chrome laesst sie laufen).
  Verwerfen bei Speicherdruck verschont Tabs mit beforeunload-Listener und Eingaben nicht
  (Chrome schon).
- beforeunload: der Host-Tab fragt beim Schliessen, sobald ein Tab mit Listener eine
  Benutzer-Aktion hatte, auch wenn dessen Handler nicht fragen wuerde. Listener nur in
  Iframes fragen beim Schliessen des Tabs nicht (nur Navigation und Neu laden).
- WebAssembly: geteilter Speicher (Threads) und JSPI, `validate()` sagt dafuer false
  und Seiten nehmen ihre Variante ohne. Zyklen zwischen Seite und Modul (Glue von
  Emscripten) werden erst mit der Seite bzw. dem Worker frei.
- CSS: `url(#...)`- und SVG-Filter malt die CPU. Gefilterte Ebenen mit Kindern,
  Maske oder Video/Canvas/WebGL, Filter-Animationen und teilweise sichtbare Ebenen
  beim Scrollen rechnen den Filter jedes Bild neu, ohne Ebenen laeuft alles auf der
  CPU. `interpolate-size`. Paint Worklet: Skript klassisch ausgewertet (kein
  `import`/`export`), Laufzeitfehler lehnen anders als in Chromium ab.
- Grafik: WebGL-Bild ueber `readPixels` statt direkt als Textur, Timer-Queries,
  Queries und Transform Feedback ueber einen Kontext-Wechsel, WebGPU. Tabs, die mit
  Compositor die GPU verloren haben, bleiben ohne Ebenen (neue Tabs bekommen sie
  wieder). Eine WebGL-Seite, die nicht zeichnet, merkt einen Verlust erst beim
  naechsten Zeichnen.
- Medien: EME (DRM), MSE in Workern (#121), WebCodecs-Bilder direkt als Textur.
  WebRTC: Verkehr ueber das Relay (TURN), Insertable Streams. Die Engine-Senke
  eines gesendeten Tracks bleibt bis `stop()` oder bis die Quelle endet. Fehler
  des MediaRecorder beim Abholen der Daten erreichen die Seite nicht als Ereignis.
  Ein stummes Autoplay-Video meldet gleich nach dem Laden kurz `pause` und wieder
  `playing` (Chrome nicht).
- Service Worker: Push, Background Sync, Background Fetch.
- Netz: HTTP-Authentifizierung (401 mit Basic/Digest) ohne Login-Dialog, die Seite zeigt
  den Inhalt der 401-Antwort. WebTransport, Streams als Request-Body, Storage Buckets,
  WebSocketStream ohne Gegendruck beim Lesen (#120).
- Speicher: localStorage schreibt WebKitLegacy erst 1 s nach einer Aenderung nach
  SQLite, beim Schliessen kann das fehlen. Mit `/data` im Speicher (zweiter
  Host-Tab) liegen Uploads im WASM-Speicher.
- Messung und Geraete: Layout-Shift- und Long-Animation-Frame-Eintraege,
  IdleDetector, `document.featurePolicy`.
- Oberflaeche: Ziehen und Loslassen ausserhalb einer Ablage oeffnet nichts (#125,
  Chrome laedt Link oder Datei im selben Tab; bewusst nicht, ein versehentliches Ablegen
  wuerde die Seite ersetzen).
- Geraete und Identitaet: WebAuthn, Credential Management, Payment Request, Web
  MIDI/USB/HID/Serial, WebXR.

## Offen: Tests und Betrieb

- `tests/e2e/mediastream-test.mjs`: Aufnahme manchmal zu kurz. Der Test misst mit der
  Uhr des AudioContext und schreibt `rectime=<Wand>:<Audio>` ins Log, um Timing von einem
  Fehler im Recorder zu unterscheiden.
- Unter Last knapp: die Speicher-Pruefung in `wasm-test.mjs` (Grenze 512 MB,
  parallel bis 446 MB gemessen), in `compositing-test.mjs` "Animation laeuft,
  waehrend das JS blockiert" (einmal rot, parallel zu drei anderen Tests) und in
  `ui-test.mjs` die beiden Pruefungen "Haengen" (Meldung nach 10 s). `serviceworker-test.mjs`
  war parallel unter Last ab "Nach Neustart" rot, allein gruen.
- Ohne Test: die Grenze fuer die Zahl der Samples in fMP4 (`trun`), das Aufraeumen
  anderer Host-Objekte als WebAssembly durch die GC, Set-Cookie beim Update eines
  Service Workers, das Zeitlimit beim Schreiben der Datenbanken (#180).
- Echte Seiten schwanken stark (Werbung, wechselnder Inhalt): Leistung immer mit
  mehreren Laeufen und mit Inklusivzeiten aus dem Profil vergleichen, nicht nur mit
  der Ladezeit.
- Spaeter: WireGuard statt Wisp (Transport ist austauschbar gebaut).
