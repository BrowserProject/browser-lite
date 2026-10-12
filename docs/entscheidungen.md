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
| 15 | Meson | Aus pip (gepinnt) statt Ubuntu-Paket | fontconfig 2.17 braucht Meson >= 1.6.1, Ubuntu 24.04 hat 1.3 |
| 16 | ICU-Daten | Selber aus dem Host-Archiv als `libicudata.a` | Im Cross-Build baut ICU nur Stub-Daten |
| 17 | GC-Wurzeln | `--spill-pointers` fuer das ganze Binary | Ohne gehen lebende Objekte verloren (mit Stresstest bewiesen) |
| 18 | Erster JSC-Build | `PORT=JSCOnly` mit Patches, eigener `PORT=Wasm` erst fuer WebCore | JSCOnly reicht fuer JSC, so bleiben die Patches klein |
| 19 | Spill + Namen | `--spill-pointers` braucht `--profiling-funcs` | Ohne Namen findet der Pass nach voller Optimierung den Stack-Pointer nicht |
| 20 | Link-Flags jsc | Nur am Target `jsc`, nicht global | Die LLInt-Extractors (mit -O0 gelinkt) vertragen `--spill-pointers` nicht |
| 21 | Theme | Adwaita (wie Win-Port) | Fertige Formular-Elemente und Scrollbars ohne Abhaengigkeiten |
| 22 | Clients | Empty-Clients per Patch ueberschreibbar machen (`final` -> `override`) | Mechanischer Patch, eigene Clients ueberschreiben nur was noetig ist |
| 23 | Event-Loop | RunLoop von aussen pumpen (WakeUp-Callback + Timer auf naechsten WebCore-Timer) | Ein Worker darf nicht blockieren, sonst kommen keine Nachrichten mehr an |
| 24 | Bild zum Host | Pixel im gemeinsamen Speicher, Host kopiert per putImageData, immer nur ein Bild unterwegs | Einfach und robust, GPU-Weg folgt in Phase 8 |
| 25 | Oberflaeche | Schlichtes HTML/CSS/JS ohne Build-Schritt statt TypeScript + Vite | Keine npm-Abhaengigkeiten, einfacher zu hosten, reicht fuer die UI |
| 26 | Compositing | Kein Accelerated Compositing, leere `GraphicsLayerWasm` | Alles wird direkt in den Pixel-Buffer gemalt. Einfach, reicht bis zum GPU-Weg |
| 27 | Exceptions | Werfen beim Link erlauben, Fangen nicht | Deps (C++) referenzieren `__cxa_throw`. Ein throw fuehrt zu abort, wie bei WebKit erwartet |
| 28 | CA-Zertifikate | Mozilla-Bundle im Datenpaket, optional `extra-ca.crt` dazu | Firmen-Netze mit eigener CA, und lokale Tests hinter einem TLS-Proxy |
| 29 | ICU-Daten | Mit `icupkg -r` filtern statt aus Quellen neu bauen | Das Quell-Archiv hat nur das fertige `.dat`. Filter auf Konverter + Sprachen spart 14 MB |
| 30 | Auslieferung | Engine pro Version in eigenem Ordner, immutable gecacht, `.br` vorkomprimiert | Nie eine alte .wasm aus dem Cache, Brotli q11 einmal beim Deploy statt bei jedem Request |
| 31 | Texteingabe | Verstecktes `<textarea>` statt Fokus auf dem Canvas | Nur so kommen tote Tasten, IME und Bildschirmtastaturen als fertiger Text an |
| 32 | Popups | Engine oeffnet den View selber (IDs ab 2^20), Oberflaeche macht einen Tab daraus | `createWindow` muss synchron eine Page liefern |
| 33 | Downloads | Datei nochmal mit eigenem CurlRequest laden, Daten an die Oberflaeche | Einfacher als den laufenden Ladevorgang umzuhaengen; die URL ist schon das Ziel nach Redirects |
| 34 | Speicher | IDBFS (JS-Dateisystem) statt OPFS/WasmFS | WasmFS hat keine Sockets, unser Netzwerk laeuft ueber SOCKFS |
| 35 | localStorage/IndexedDB | Dateien aus `WebKitLegacy/Storage` mitbauen | Fertige, getestete Implementierung (InProcessIDBServer, StorageAreaSync) statt eigener |
| 36 | GC-Wurzeln (Engine) | GC nur auf leerem Stack (DeferGC um jede Aufgabe, Patch 0012) statt `--spill-pointers` | Der Pass machte alles etwa 10x langsamer und die .wasm 34 MB groesser. Mit Stresstest abgesichert (ohne Verschiebung Absturz) |
| 37 | Schriften | fontconfig-Cache beim Build erzeugen, Schrift-Ordner bekommen mtime 0 | fontconfig haelt den Cache dann fuer gueltig und liest die Schriften nicht bei jedem Start neu ein |
| 38 | Fehlender Content-Type | Wie andere Browser raten (Endung, sonst HTML) | Sonst wurde die Seite als Download behandelt |
| 39 | WebSockets | `WebSocketChannel` + `SocketStreamHandle` aus WebKitLegacy kopiert (`engine/src/websocket/`), eigener Socket auf WebCores `CurlStreamScheduler` | WebCore hat fuer single-process keinen WebSocket-Kanal mehr; WebKitLegacy hat nur eine Cocoa-Variante (CFNetwork) |
| 40 | Video | `ENABLE_VIDEO` an, noch ohne MediaPlayer-Backend | Seiten erwarten die Media-API (`video.pause()` usw.). Abspielen kommt mit Phase 9 ueber den Host-Browser |
| 41 | Web Audio | Engine rendert auf eigenem Thread in einen Ring im WASM-Speicher, AudioWorklet im Host spielt ab | Kein Kopieren ueber postMessage, kein Lock. Das Worklet kann den gemeinsamen Speicher direkt lesen |
| 42 | Audio-Dekoder | `decodeAudioData` ueber `OfflineAudioContext` des Host-Browsers | Kann alle Formate des Browsers, ohne ffmpeg & Co. im WASM |
| 43 | FFT | Eigene kleine Radix-2-FFT statt einer Library | WebCore hat sonst nur vDSP (Apple) oder GStreamer. Fuer die Groessen in Web Audio reicht das |
| 44 | Favicons | Engine laedt das Icon selber und schickt die Bytes an die Oberflaeche | Die Oberflaeche hat kein eigenes Netz (alles geht ueber das Relay), so kommen auch Cookies mit |
| 45 | Vollbild | Ganzer Seitenbereich (`#viewport`) geht in den Vollbild-Modus, nicht ein einzelnes Element | Die Engine malt alles in ein Canvas; WebCore legt das Element selber ueber die ganze Seite |
| 46 | Video abspielen | Host-`<video>` spielt ab, Engine malt die kopierten Bilder | Alle Codecs des Browsers, Ton ohne Umweg. Bilder kopieren kostet etwas CPU, dafuer stimmen Ueberlagerung, Clipping und Scrollen genau |
| 47 | Video-Daten | Service Worker fragt die Engine in Stuecken (Range, 2 MB) | Die Oberflaeche hat kein Netz; das naechste Stueck kommt erst, wenn der Browser liest, so bleibt der Speicher klein |
| 48 | MSE | WebCore-MSE mit eigenen Parsern (nur Zeitstempel), Daten zusaetzlich an MediaSource im Host | So stimmen `buffered`, Springen und Events wie im Standard, dekodiert wird trotzdem vom Browser |
| 49 | Ausgerichteter Speicher | WTF rundet die Groesse bei `aligned_alloc` auf ein Vielfaches der Ausrichtung auf (Patch 0015) | Emscripten gibt sonst nullptr zurueck (C11-Regel) und WebKit stuerzt ab, z.B. beim HRTF-Laden |
| 50 | WebKit-Fehler in `VectorMath::multiplyComplex` | Ergebnis erst zwischenspeichern (Patch 0013) | Der Code ohne SIMD ueberschrieb den Realteil zu frueh, die FFT-Faltung (ConvolverNode, HRTF) war falsch. Faellt auf x86/ARM nicht auf, weil dort SIMD rechnet |
| 51 | WebGL | Kein ANGLE im WASM, die GL-Aufrufe gehen an Emscriptens GLES (WebGL des Host im Engine-Worker) | ANGLE nach WASM waere sehr gross und wuerde am Ende auch nur WebGL aufrufen. Der Browser prueft Shader und Grenzen sowieso selber |
| 52 | WebGL-Version | WebGL-1-Seite bekommt WebGL-1-Kontext im Host, WebGL 2 einen WebGL-2-Kontext | Ohne den Shader-Uebersetzer von ANGLE muss die Shader-Sprache genau passen |
| 53 | ANGLE-Funktionen | Mit `tools/gen-angle-shim.py` aus den Khronos-Headern erzeugt, Rest von Hand | Rund 300 Funktionen, fast alle 1:1. Bei einem WebKit-Update einfach neu erzeugen |
| 54 | Viele WebGL-Kontexte | Ein Host-Kontext pro WebGL-Version, Zustand beim Wechsel speichern/laden | Chrome erlaubt im Worker nur 4 Kontexte. Fingerprinting- und Feature-Tests legen oft kurz eigene Kontexte an, sonst ginge der Kontext der Seite verloren |
| 55 | Bild-Encoder | Skia-Encoder an (PNG, JPEG, WebP) | Ohne sie lieferte `toDataURL`/`toBlob` immer `data:,`. Die Libs waren im sysroot schon da |
| 56 | WebAssembly der Seiten | Module in der WASM-Engine des Browsers, API in JSC nachgebaut | JSC kann ohne JIT kein WebAssembly. Ein Interpreter im WASM waere 20-50x langsamer, so laeuft es fast mit voller Geschwindigkeit |
| 57 | Speicher der Module | Modul umschreiben: Speicher ist ein Bereich im Engine-Speicher, jeder Zugriff mit Grenzpruefung | JSC muss `memory.buffer` als normalen ArrayBuffer zeigen, der muss im Engine-Speicher liegen. Die Pruefung haelt jedes Modul in seinem Bereich |
| 58 | Basis/Groesse im Code | Pro Funktion in Locals, neu laden nach Aufrufen | Importierte Globals bei jedem Zugriff zu lesen machte den Code ca. 3x langsamer, so sind es ca. 12 % |
| 59 | WebAssembly-API | Erst beim ersten Zugriff auswerten (Getter auf dem globalen Objekt) | Die meisten Seiten brauchen kein WebAssembly, so kostet es dort nichts |
| 60 | GC waehrend langer Skripte | Eigener VM-Trap, gesammelt nur im Interpreter an `op_check_traps` und nur ohne verschachtelten C++-Aufruf | Dort liegen alle Werte im Speicher, nicht in WASM-Locals. Erste Seite: Spitze 443 statt 531 MB. `--spill-pointers` waere wieder 14x langsamer |
| 61 | Speicher freigeben | `WebCore::releaseMemory` automatisch ab 192 MB belegt, nicht nur bei Speicherdruck | WASM-Speicher schrumpft nie und einen Speicherdruck meldet der Browser nicht. Kostet ca. 0.3 s, darum hoechstens alle 5 s und erst nach 64 MB Zuwachs |
| 62 | Aufruf-Caches im Interpreter | `forceICFailure` auf WASM aus (Patch 0019) | Die Option ist auf 32 Bit standardmaessig an und betrifft sonst nur JIT-Code, den wir nicht haben. Die Caches des Interpreters sind auch fuer 32 Bit fertig; ohne sie war jeder Aufruf ein Umweg ueber C++ |
| 63 | Skia auf WASM | SSE4.1-Pfad ueber Emscriptens SSE-Abbildung auf WASM-SIMD (Patch 0020) | Die skalare Pipeline malt ein Pixel pro Schritt. Mit SSE4.1 halbiert sich die Malzeit. Ein eigener WASM-SIMD-Pfad in Skia waere viel mehr Arbeit |
| 64 | Ausloeser fuer Speicherfreigabe | Wachstum von `malloc_footprint()` statt belegtem Speicher | Kostet nichts und trifft genau den Moment, in dem sonst der WASM-Speicher waechst |
| 65 | TLS-Cipher | ChaCha20-Poly1305 vor AES-GCM, auch fuer TLS 1.3 | Ohne AES-Hardware ist ChaCha20 in Software ca. 4x schneller. Vorher galt fuer TLS 1.3 die Standardliste von OpenSSL (AES-256-GCM zuerst), weil WebKit nur die TLS-1.2-Liste setzt |
| 66 | WebCrypto | OpenSSL-3-Fehler in WebKits Code reparieren statt eigene Umsetzung | Nur zwei kleine Stellen (Reihenfolge bei AES-GCM, Makro-Pruefung bei RSA). Damit gehen die AWS-WAF-Pruefungen (SBB, IMDb, Booking) |
| 67 | SQLite-Dateien | Eigenes VFS im WASM-Speicher, ganze Dateien ins IDBFS schreiben | Jeder Dateizugriff ging synchron ueber den Haupt-Thread (Emscriptens JS-Dateisystem). WasmFS waere die allgemeine Loesung, geht aber nicht zusammen mit den Sockets von SOCKFS |
| 68 | Sockets | Eigene Schicht im WASM (`--wrap` beim Linken) statt Emscriptens SOCKFS | Kein synchroner Umweg ueber den Haupt-Thread fuer jedes send/recv/poll mehr. Der Transport bleibt austauschbar (spaeter WireGuard). Kein Patch an curl noetig |
| 69 | Haupt-Thread und Locks | Auf dem Haupt-Thread unter einem Lock nichts, was warten kann | Emscripten arbeitet beim Warten auf dem Haupt-Thread die Warteschlange ab, das fuehrte zu Selbst-Deadlocks (nzz.ch, 20min.ch haengten ab und zu) |
