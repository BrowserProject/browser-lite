# Architektur

## Grosses Bild

```
Haupt-Thread (Seite browser-lite)            Engine-Worker (WASM, pthreads)
+--------------------------------+           +-------------------------------------+
| UI (TS): Tabs, Adressleiste    |  post-    | WasmWebView (unser Embedding)       |
| Canvas (OffscreenCanvas owner) |  Message  |   WebCore Page/Frame + Clients      |
| Input: Maus/Tastatur/Scroll/   | <-------> |   JavaScriptCore (CLoop)            |
|   Clipboard -> Events          |           |   Skia -> OffscreenCanvas (WebGL2)  |
+--------------------------------+           |   Netzwerk: WebCore curl-Backend    |
                                             |     libcurl + nghttp2 + OpenSSL     |
                                             |     Sockets -> Transport-Interface  |
                                             |   Storage: WasmFS + OPFS            |
                                             +------------------|------------------+
                                                                | Transport (austauschbar)
                                                                v
                                             WispTransport (jetzt) / WireGuardTransport (spaeter)
                                                                | WebSocket (wss)
                                                                v
                                             VPS: Caddy (Static + COOP/COEP) + Wisp-Relay (mit Auth)
```

## Die Teile

### WebKit-Port `PORT=Wasm`
WPE WebKit ist eigentlich multi-process (UI-, Web- und Network-Prozess mit IPC ueber
Unix-Sockets) und haengt an GLib und libsoup. Das passt nicht in WASM. Darum machen wir
einen eigenen kleinen Port:

- Basis ist der WebKit-Stand vom WPE-Release (siehe `versions.env`).
- Aufbau wie der PlayStation-Port: WTF `RunLoopGeneric` (kein GLib), WebCore curl-Backend
  fuer Netzwerk, statisch gelinkt.
- Grafik wie WPE: Skia (WPE nutzt seit 2.46 Skia statt Cairo).
- Kein WebKit2/IPC. WebCore laeuft single-process, wir binden `WebCore::Page` direkt an
  (aehnlich wie frueher WebKitLegacy).
- Ein neuer Port braucht in WebKit: Eintrag in `ALL_PORTS`, `Source/cmake/OptionsWasm.cmake`,
  und pro Projekt `PlatformWasm.cmake`. Unser Code dafuer liegt in `port/`, die noetigen
  Aenderungen an WebKit in `patches/webkit/`.

### JavaScript
JavaScriptCore mit dem **CLoop**-Interpreter (`ENABLE_JIT=OFF`, `ENABLE_C_LOOP=ON`).
In WASM kann man nicht einfach Maschinencode erzeugen, darum kein JIT. JS ist dadurch
langsamer als normal, einfache und mittlere Seiten gehen aber gut.

### Garbage Collector (wichtigstes Risiko)
JSC hat einen konservativen GC: er sucht auf dem Stack nach allem was wie ein Pointer
aussieht. In WASM gibt es zwei Stacks:

1. Den "Shadow-Stack" im Linear Memory (dort liegen Variablen deren Adresse genommen wird).
2. Die WASM-Locals der VM, die man **nicht** lesen kann.

Wenn ein Pointer auf ein JS-Objekt nur in einem WASM-Local liegt, sieht der GC ihn nicht
und kann das Objekt freigeben, obwohl es noch gebraucht wird. Das gibt seltene, schwer
reproduzierbare Abstuerze. Loesungsansaetze (wird in Phase 2 geklaert):

- Binaryen-Pass `--spill-pointers`: alle pointer-grossen Locals werden vor Calls auf den
  Shadow-Stack geschrieben, der GC scannt dann den Shadow-Stack.
- Fallback: GC nur an sicheren Punkten laufen lassen (wenn der Event-Loop leer ist und
  kein JS/C++ mehr auf dem Stack ist).

Ausserdem: `Thread::suspend` geht in WASM nicht (keine Signale). Darum pro JS-VM nur ein
Thread, Sampling-Profiler aus.

### Rendering
- Zuerst Skia CPU-Raster in einen Buffer, dann als ImageBitmap auf das Canvas.
- Spaeter Skia Ganesh auf WebGL2 im OffscreenCanvas mit Compositing (Scrollen ohne neu
  malen).

### Netzwerk
- WebCore curl-Backend (`Source/WebCore/platform/network/curl/`), libcurl mit nghttp2
  (HTTP/2) und OpenSSL (das curl-Backend von WebCore nutzt direkt die OpenSSL-API).
- libcurl denkt es hat normale Sockets. Unsere Socket-Schicht leitet `connect/send/recv/poll`
  an ein **Transport-Interface** weiter (`engine/net/transport.h`).
- `WispTransport`: jede TCP-Verbindung ist ein Stream in einer Wisp-WebSocket-Verbindung.
  Hostnamen werden vom Relay aufgeloest.
- Spaeter `WireGuardTransport`: userspace TCP/IP + WireGuard im WASM, UDP-Pakete ueber
  Wisp-UDP. WebCore und curl merken davon nichts.

### Threads
Emscripten pthreads, braucht `SharedArrayBuffer`. Dafuer muss die Seite mit diesen Headern
ausgeliefert werden:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Speicher
WasmFS mit OPFS-Backend fuer Cookies, localStorage, IndexedDB und Cache. Bleibt also
zwischen Besuchen erhalten.

### Hosting
Auf dem VPS mit Docker Compose: Caddy (HTTPS, die Header oben, Brotli) und das Wisp-Relay.
Das Relay braucht Auth (sonst nutzen fremde Leute den Server als Proxy) und blockiert
private IP-Bereiche.
