# Stand und offene Punkte (16.10.2026)

Kurze Uebersicht, wo das Projekt gerade steht und was noch offen ist. Details zu
den einzelnen Punkten stehen in [entscheidungen.md](entscheidungen.md) (Nummern
#...), die Phasen in [roadmap.md](roadmap.md).

## Was laeuft

- WebKit (WebCore + JavaScriptCore mit CLoop-Interpreter) als WebAssembly in
  einem Tab, eigenes Netz ueber Wisp-Relay, TLS im WASM. Das Relay verbindet nur
  zu oeffentlichen Adressen und Web-Ports.
- Basis-Browser ohne Komfort-Funktionen (kein Passwort-Speicher, kein PDF-Viewer,
  #130): Tabs, Verlauf (auch `pushState`), Lesezeichen, Downloads, Zoom,
  Pinch-Zoom wie Chrome (nur die Ansicht, im Compositor-Thread), Suche auf der
  Seite. `mailto:`, `tel:` und andere Schemata gehen nach einem Klick an den
  Host-Browser.
- Absturz und Haengen: die Oberflaeche zeigt es an, "Neu starten" stellt die
  Sitzung wieder her. Ein Skript, das die Engine laenger als 30 s blockiert, bricht
  der Watchdog ab (`BL_SCRIPT_TIMEOUT`, 0 = aus).
- GPU-Rastern (Skia ueber WebGL 2), Compositing mit eigenem Thread, asynchrones
  Scrollen, Blur und Schatten auf der GPU (gefilterte Ebenen werden
  wiederverwendet), CSS Paint Worklet. Nach einem GPU-Verlust malt die Engine auf
  der CPU weiter und kehrt auf die GPU zurueck, WebGL-Seiten bekommen
  `webglcontextlost` und `webglcontextrestored`.
- Medien (Video/Audio auch aus `blob:` und `data:`, MSE, WebCodecs, WebRTC,
  getUserMedia) ueber den Host-Browser.
- WebAssembly der Seiten in der WASM-Engine des Host, auch memory64, table64 und
  mehrere Speicher (hoechstens 2 GB pro Speicher, 64 verschachtelte Aufrufe).
- Service Worker mit Update im Hintergrund, Navigation Preload, Benachrichtigungen
  und `clients.openWindow()` nach `notificationclick`.
- Speicher: WasmFS, `/data` im OPFS (#142, nur ein Host-Tab besitzt es), HTTP- und
  Bytecode-Cache in der Cache API (#70, #135), Inhalte der Cache API der Seiten als
  eigene Dateien. `navigator.onLine` folgt der Verbindung zum Relay.
- Messlatte: 257 von 280 Funktionen wie Chromium (`tests/e2e/parity-test.mjs`).
- Tests: gemeinsames Geruest fuer die e2e-Tests (`tests/e2e/harness.mjs`, auch
  parallel), dazu Grenzen (`limits.html`), Watchdog (`hang.html`), echte Abstuerze
  (`BL_TEST_HOOKS=1`) und Netzfehler (falsche Zertifikate, DNS, Relay-Neustart).
- CI und Deploy bei jedem Push auf `main` (Stand in GitHub Actions). Der Deploy
  laeuft ueber den Self-hosted Runner auf den eigenen Proxmox-Server (LXC), auf dem
  Runner laeuft keine fremde Action.

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
   arbeitet lange Stuecke (1-1.5 s) ohne Pause. Aufgaben anderer Threads warten unter
   Last bis 3.7 s im Postfach von Emscripten, Abholen bei jedem Durchgang brachte nichts.
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
  Zwischenstand wuerde alle Kacheln neu malen). Strg + Rad geht nicht zuerst an die
  Seite (eigener Zoom von Karten und Editoren). Zwei Finger warten auf die
  touchstart-Antwort der Seite, auch ohne blockierende Touch-Listener. Die
  Uebernahme am Ende kostet einen Style- und Layout-Durchlauf.
- WebAssembly: geteilter Speicher (Threads) und JSPI, `validate()` sagt dafuer
  false und Seiten nehmen ihre Variante ohne. Zyklen zwischen Seite und Modul werden
  erst mit der Seite frei.
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
  eines gesendeten Tracks bleibt bis `stop()` oder bis die Quelle endet (schwach
  gehalten wurde die Spur im GC zerstoert und beendete die Quelle, Absturz). Fehler
  des MediaRecorder beim Abholen der Daten erreichen die Seite nicht als Ereignis.
- Service Worker: Push, Background Sync, Background Fetch. `WindowClient.focus()`
  holt den Tab nicht nach vorne, Navigation Preload fragt den HTTP-Cache nicht.
- Netz: WebTransport, Streams als Request-Body, Storage Buckets, WebSocketStream
  ohne Gegendruck beim Lesen (#120).
- Messung und Geraete: Layout-Shift- und Long-Animation-Frame-Eintraege,
  IdleDetector, `document.featurePolicy`.
- Oberflaeche: Ziehen und Loslassen ausserhalb einer Ablage oeffnet nichts (#125,
  Chrome oeffnet einen Tab). Eingefuegte Dateien bleiben bis zum Schliessen des Tabs
  im WASM-Speicher. Unterdrueckte Dialoge sind am Tab nicht zu sehen.

## Offen: Tests und Betrieb

- `tests/e2e/mediastream-test.mjs`: Aufnahme manchmal zu kurz. Der Test misst mit der
  Uhr des AudioContext und schreibt `rectime=<Wand>:<Audio>` ins Log, um Timing von einem
  Fehler im Recorder zu unterscheiden.
- Unter Last knapp: die Speicher-Pruefung in `wasm-test.mjs` (Grenze 512 MB,
  parallel bis 446 MB gemessen) und in `compositing-test.mjs` "Animation laeuft,
  waehrend das JS blockiert" (einmal rot, parallel zu drei anderen Tests).
- Ohne Test: die Grenze fuer die Zahl der Samples in fMP4 (`trun`), das Aufraeumen
  von Host-Objekten durch die GC, Set-Cookie beim Update eines Service
  Workers.
- Zu pruefen: in Seiten-Workern kehrt der Engine-Thread nie in den Event-Loop des
  Host zurueck, die FinalizationRegistry der WASM-Bruecke im Host feuert dort
  vermutlich nie (Werte erst mit dem Worker frei).
- Echte Seiten schwanken stark (Werbung, wechselnder Inhalt): Leistung immer mit
  mehreren Laeufen und mit Inklusivzeiten aus dem Profil vergleichen, nicht nur mit
  der Ladezeit.
- Spaeter: WireGuard statt Wisp (Transport ist austauschbar gebaut).
