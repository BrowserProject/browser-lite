# Stand und offene Punkte (16.10.2026)

Kurze Uebersicht, wo das Projekt gerade steht und was noch offen ist. Details zu
den einzelnen Punkten stehen in [entscheidungen.md](entscheidungen.md) (Nummern
#...), die Phasen in [roadmap.md](roadmap.md).

## Was laeuft

- WebKit (WebCore + JavaScriptCore mit CLoop-Interpreter) als WebAssembly in
  einem Tab, eigenes Netz ueber Wisp-Relay, TLS im WASM.
- Basis-Browser ohne Komfort-Funktionen (kein Passwort-Speicher, kein PDF-Viewer,
  #130): Tabs, Verlauf, Lesezeichen, Downloads, Zoom, Suche auf der Seite.
- GPU-Rastern (Skia ueber WebGL 2), Compositing mit eigenem Thread, asynchrones
  Scrollen.
- Medien (Video/Audio, MSE, WebCodecs, WebRTC, getUserMedia) ueber den Host-Browser.
- Speicher: WasmFS, `/data` im OPFS (#142), HTTP- und Bytecode-Cache in der
  Cache API (#70, #135).
- Messlatte: 252 von 277 Funktionen wie Chromium (`tests/e2e/parity-test.mjs`).
- CI gruen bis `120b0b8` (bzw. siehe letzter Lauf).

## Messwerte (lokal, erster Besuch)

Aus `tests/e2e/site-test.mjs` (Spalte "erstes Layout" seit #144), Zeit ab Start
der Oberflaeche:

| Seite | Erstes Layout | Geladen |
|---|---|---|
| YouTube | 2.8 s | 5.6 s |
| GitHub | 3.5 s | 3.0 s |
| weather.com | 2.5 s | 58-97 s |
| NZZ | 3.4 s | 14-21 s |
| CNN | 4.6 s | 14-25 s |
| Wikipedia (Schweiz) | 4.1-4.4 s | 7.5-8.3 s |
| Twitch | 6.7 s | 8-34 s (Inhalt wechselt) |
| 20min | 7.6 s | 22.5 s |

## Offen: Leistung (nach Nutzen)

1. **Erstes Layout auf schweren Seiten** (Wikipedia, 20min, Twitch 4-7 s): der
   HTML-Parser arbeitet lange Stuecke (1-1.5 s) ohne Pause, das erste Malen nach
   dem ersten Layout kostet nochmals ca. 0.8 s. Zu pruefen: wann der Parser fuer ein
   Rendering-Update unterbricht, was im ersten Rendering-Update so teuer ist.
2. **Kompilieren beim ersten Aufruf** (weather.com ca. 11 s Parser + Bytecode):
   beim zweiten Besuch hilft der Bytecode-Cache (#135), beim ersten nicht.
3. **Interpreter-Eigenzeit** (CLoop, 15-21 % auf JS-lastigen Seiten): nur mit
   grossem Umbau deutlich schneller (Interpreter mit Tail-Calls oder ein JIT nach
   WASM). Kleine Caches sind gemacht (#143), polymorpher Cache lohnt laut Zaehlung
   nicht.
4. **PiP-Teil des WebRTC-Polyfills**: fasst beim Start jedes Frames
   `HTMLVideoElement`, `Document` und `ShadowRoot` an (ca. 0.2 s auf weather.com,
   #145).
5. **Erzwungenes Flex/Grid-Layout** durch JS (20min ca. 6.5 s, #141): kein
   billiger Fix gefunden.
6. **GC** 5-7 % auf JS-lastigen Seiten (#60, #122).

## Offen: Funktionen

- Echtes Pinch-Zoom wie Chrome (nur Ansicht skalieren, im Compositor-Thread).
- CSS-Filter auf der GPU, Paint Worklet, `interpolate-size`.
- Push, Background Sync, Storage Buckets, WebTransport, WebGPU.
- WebRTC: Verkehr ueber das Relay (TURN), Insertable Streams.
- Service Worker: Skript im Hintergrund aktualisieren, Navigation Preload.

## Offen: Tests und Betrieb

- `tests/e2e/mediastream-test.mjs` ist manchmal rot (Aufnahme nur 1.2 statt
  2.5 s lang, Timing). Zweimal wiederholt gruen.
- Echte Seiten schwanken stark (Werbung, wechselnder Inhalt): Leistung immer mit
  mehreren Laeufen und mit Inklusivzeiten aus dem Profil vergleichen, nicht nur mit
  der Ladezeit.
- Relay und Seite auf dem eigenen VPS (Deploy-Job braucht die Secrets).
- Spaeter: WireGuard statt Wisp (Transport ist austauschbar gebaut).
