# Notizen zum Referenzprojekt WebkitWasm

Projekt: <https://github.com/theogbob/WebkitWasm> (angeschaut am 2026-10-11, Commit `68c6185`).
Lizenz: BSD-2-Clause, Copyright theogbob. Wenn wir Code oder Ideen 1:1 uebernehmen,
muss der Copyright-Hinweis mit.

## Was es ist

Ein Forschungsprototyp: WebCore + JSC nach WASM mit Emscripten, single-process,
eigener `PORT=Emscripten`, Skia, Netzwerk ueber Wisp. Laedt echte Seiten (sogar Discord),
aber mit bekannten Problemen.

## Was wir uebernehmen (als Idee)

- **Port-Aufbau wie PlayStation-Port** (curl + RunLoopGeneric + Skia + statisch, ohne
  GLib/libsoup/WebKit2). Ein "abgespecktes WPE" haben sie bewusst verworfen. Wir machen das
  gleich, unser Port heisst `PORT=Wasm`.
- **Neuer Port = 3 Stellen**: `ALL_PORTS` in `WebKitCommon.cmake`, `OptionsXxx.cmake`,
  `PlatformXxx.cmake` pro Projekt (WTF, JSC, PAL, WebCore).
- **OpenSSL** statt mbedTLS: das WebCore curl-Backend benutzt direkt die OpenSSL-API.
- **fontconfig wird gebraucht**: `FontCacheSkia` ruft fontconfig direkt auf. Also fontconfig
  nach WASM bauen statt rauspatchen.
- **ICU selber bauen**: die Emscripten-Ports haben ICU 68.2, WebKit braucht mindestens 70.1.
  Alle Dependencies selber bauen und pinnen.
- **Socket-Schicht**: Emscripten SOCKFS mit einer WebSocket-Klasse von wisp-js ausgetauscht
  (wie bei libcurl.js). Kein C-Code fuer Wisp noetig. Wir wollen trotzdem ein eigenes
  Transport-Interface, damit WireGuard spaeter passt.
- **Wisp-Server**: wisp-js (v2). wisp-server-python kann nur Wisp v1.
- **curl im Main-RunLoop pumpen**: `CurlRequestScheduler` laeuft ohne eigenen Thread, ein
  nicht-blockierender `curl_multi_perform` pro Durchlauf. Callbacks per `callOnMainThread`,
  damit nichts aus curl heraus re-entrant aufgerufen wird.
- **Fallen beim FrameLoaderClient**: Die `EmptyFrameLoaderClient`-Defaults blockieren alles
  (Policy-Entscheide werden verworfen, `canHandleRequest()=false`, `canShowMIMEType()=false`,
  `committedLoad()` macht nichts). Man braucht einen eigenen, vollstaendigen Client.
- **`ENABLE_FTPDIR=ON` macht curl kaputt**: `CURLOPT_PROTOCOLS_STR` scheitert an "ftp" wenn
  curl ohne FTP gebaut ist, danach geht kein http mehr. FTPDIR aus lassen.
- **`Thread::suspend` geht nicht** (keine Signale in WASM): ein JS-Thread pro VM,
  Sampling-Profiler aus, harter `RELEASE_ASSERT` falls doch jemand suspend aufruft.
- **Link-Flags** als Startpunkt: `-sSTACK_SIZE=8MB`, `-sDEFAULT_PTHREAD_STACK_SIZE=2MB`,
  `-sPROXY_TO_PTHREAD`, Thread-Pool vorher anlegen.
- **Build-RAM**: WebCore Unified-Sources brauchen ca. 1.2 GB+ pro Compiler-Prozess.
  Mit 4 parallelen Jobs ca. 5 GB, passt also auf GitHub-Runner (16 GB).
- **GPU-Present**: nur ein Frame "in flight" (Tiefe 1), sonst wird der Haupt-Thread
  geflutet und es ruckelt.

## Was wir anders machen

- **Reproduzierbar**: Bei ihnen fehlen die Build-Skripte fuer die Dependencies
  (`tools/build-deps/` ist nicht im Repo). Bei uns ist alles im Repo, gepinnt mit Hash,
  und CI baut alles von null.
- **Patches aufgeteilt**: Sie haben einen grossen Patch (3459 Zeilen, 68 Dateien).
  Wir machen viele kleine nummerierte Patches, das macht WebKit-Updates einfacher.
- **GC-Wurzeln in WASM-Locals**: Sie haben einen offenen, seltenen JSC-Absturz
  (`materializePropertyTable`, Offset immer um genau 1 falsch, bei Discord). Unsere Vermutung:
  das koennte mit Pointern zu tun haben, die nur in WASM-Locals liegen und vom konservativen
  GC nicht gesehen werden (eine Structure wird zu frueh freigegeben). Das gehen wir in
  Phase 2 von Anfang an an (`--spill-pointers` oder GC nur an sicheren Punkten) und testen
  es mit GC-Stresstests. Ist aber nur eine Hypothese, kann auch ein anderer Bug sein.
- **WebKit-Version**: Sie sind auf `webkitglib/2.52`, wir auf einem WPE-Release (`WEBKIT_TAG` in
  `versions.env`).
- **Netzwerk austauschbar** (Transport-Interface) wegen WireGuard spaeter.
- **Groesse**: Ihr .wasm ist ca. 107 MB. Wir wollen mit Feature-Trimming, `-Oz`/`-O3` je
  nach Teil und Brotli deutlich drunter kommen.
