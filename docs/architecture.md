# Architecture

How browser-lite is built, from the engine artifact up to the demo. Numbers like #142 refer to
[decisions.md](decisions.md).

## Layers

```
 your page / apps/demo          tabs, address bar, settings (only public package APIs)
   |
   |  @browser-lite/ui          unstyled handlers: select popup, pickers, prompts, dialogs, menus
   |  @browser-lite/profile     optional: server-side profile into the storage namespace
   v
 @browser-lite/core             createBrowser, Browser, View, services, media service worker
   |  Module.blTransport            ^ events, hooks (main thread)
   v                                |
 @browser-lite/transport-wisp   engine.js / engine.wasm / engine.data (engine/)
   |  WebSocket (Wisp v1)           WebCore + JavaScriptCore + embedder, pthreads in Web Workers
   v
 @browser-lite/server           createRelay (Wisp -> TCP), static COI files, tokens, profile store
   |  TCP
   v
 the internet
```

| Layer | Folder | Role |
|---|---|---|
| Engine artifact | `engine/` | WebKit (`PORT=Wasm`) plus our embedder, built to three files. Contract: [engine/abi.json](../engine/abi.json), rules in [engine/README.md](../engine/README.md) |
| Core | `packages/core` | The only code that touches the Emscripten module. Loads the engine, maps options to the engine environment (`config.ts`), frames, input, storage lock, watchdog, request handlers, events |
| Services | `packages/core/src/services` | Host features a page may reach (`audio`, `media`, `capture`, `webrtc`, `devices`). Each enables its features in `BL_FEATURES` and registers its host calls |
| Transport | `packages/transport-wisp` | `Transport` implementation: TCP streams over a few WebSockets ([PROTOCOL.md](../packages/transport-wisp/PROTOCOL.md), #235) |
| UI | `packages/ui` | Default request handlers and helpers in plain DOM, styled by the page |
| Profile | `packages/profile` | Downloads a profile before start (`storage.beforeStart`), syncs it while running |
| Server | `packages/server` | Node: relay, static files with COOP/COEP/CORP, tokens, profile store, `browser-lite-server` CLI |
| Demo | `apps/demo` | A full browser for testing, built only on the packages |

`tests/contract/deps-test.mjs` enforces the direction: core imports no other package, the
others import core only as types, apps and examples use package entry points only.

## WebKit port

WPE WebKit is multi-process (UI, web and network process over Unix sockets) and depends on GLib
and libsoup, which does not fit WASM. The `PORT=Wasm` port is structured like the PlayStation
port (WTF `RunLoopGeneric`, WebCore curl backend, static) with WPE's graphics (Skia). There is no
WebKit2: `WebCore::Page` is driven directly (like WebKitLegacy), and what WebKit2 keeps in the
network process (service workers, Cache API, OPFS, downloads) runs on the engine thread
(`engine/src/`). A new port needs an entry in `ALL_PORTS`, `Source/cmake/OptionsWasm.cmake` and
a `PlatformWasm.cmake` per project (patch 0006). All WebKit changes are patches in
`engine/patches/` ([build.md](build.md)).

## Threads

Emscripten pthreads need `SharedArrayBuffer`, hence cross-origin isolation
([embedding.md](embedding.md)). Every pthread is a Web Worker running `engine.js`.

| Thread | Does |
|---|---|
| Page main thread | Core: DOM, input, events, host calls (media, capture, devices), transport, frames without compositing |
| Engine thread (`main()`, `-sPROXY_TO_PTHREAD`) | WebCore and JSC for all views, the event loop (`EngineLoop.cpp`), every `bl_*` export |
| Compositor | Composites layers with its own WebGL 2 context into the view canvases it owns (#98) |
| Scrolling | WebCore's scrolling tree; wheel and swipe go there through the compositor (#101) |
| Tile painters, image decoder, curl, IndexedDB, Web Audio, page workers | Background work; 8 pooled workers plus 4 loaded in reserve (#242) |

Every thread instantiates `engine.wasm` itself. A split engine (#238) has the code that the
start and common pages do not run in chunks `engine.deferred-<n>.wasm`: the core compiles them
one after the other after the start, the main thread instantiates each at once, the workers at
their first call into it (`engine/js/deferred.js`); a thread that needs a chunk before the core's
copy arrived reads and compiles it synchronously.
| WasmFS OPFS proxy | Synchronous access handles for `/data` (#142) |

Rule for main thread code: while waiting for a lock (also malloc's) Emscripten runs the main
thread's queue, so never hold a lock that a queued task could take (#69).

A thread that traps or aborts ends the engine. Its worker writes the error with the stack into
static engine memory (`bl__crash_reason`) before the error reaches the main thread, where the
core reports it as the reason of `crash` (#218).

All views share one engine thread. A JS entry may run at most 30 s (`scriptTimeoutSeconds`,
#146). The core watchdog emits `unresponsive` when input or an expected answer gets no reply
within 10 s (#147, #172). A page dialog holds only its page: until the answer the engine thread
runs the other views in a nested event loop (`runNestedEventLoop`, #258).

## Frames

Each view canvas is transferred to the presenter worker (`transferControlToOffscreen`, #83).
Skia rasterizes with Ganesh on WebGL 2 in the engine worker (#86); without WebGL 2 or with
`engine.gpu: false` on the CPU, where patch 0020 lets Skia use SSE4.1 mapped to WASM SIMD.
Compositing follows WPE's Coordinated Graphics (`LayerTreeHostWasm.cpp`): the engine thread
updates and flushes, tile threads paint, the compositor thread composites, so `transform` and
`opacity` animations and scrolling continue while JS blocks (#94, #98). Blur and shadow run on
the GPU with cached filtered layers (#156); `url()` and SVG filters on the CPU. Damage tracking
like WPE (`ENABLE_DAMAGE_TRACKING`, #220): the layers report what changed, a frame without a
visible change is neither composited nor shown, otherwise the compositor composites the whole view
(compositing only the damage would need a copy of the view per frame, which costs more under
SwiftShader). Pinch zoom scales the shown tiles on the compositor and commits once at the end
(#150). After GPU loss the engine paints on the CPU and returns to the GPU on restore (#157).
A JPEG drawn at half its size or smaller decodes at 1/2, 1/4 or 1/8 (WebKit's subsampling level,
libjpeg-turbo scales in the DCT, patch 0054), drawn larger later it decodes again (#270).
Without a transferable canvas the engine hands pixels in shared memory (`onEngineFrame`).

## WebGL

ANGLE is not built: a small shim in `platform/wasm/angle/` (patch 0016, generated by
`tools/gen-angle-shim.py`) forwards WebKit's ANGLE calls to Emscripten's GLES, a real host WebGL
on an OffscreenCanvas in the engine worker (#51, #53). WebGL 1 pages get a WebGL 1 context, WebGL 2
pages a WebGL 2 context; the host browser validates the shaders. Chrome allows only 4 active
contexts per worker, so all contexts share one host context per WebGL version and
`ANGLEShimWasm.cpp` saves and restores the GL state on every switch (#54, #115). Each context has
its own default VAO and transform feedback object, and texture units a context never used are
cleared, so no page sees another page's data. After each frame `GraphicsContextGLWasm` reads the
pixels with `readPixels` into the page or, with compositing, into a layer. A lost context reports
`webglcontextlost` at its next `clear` or draw, never synchronously from `makeContextCurrent`
(WebGL often holds `objectGraphLock` there, #157).

## Input

Mouse, wheel, touch, touchpad pinch and keyboard go from the canvas to `bl_*` exports
(`packages/core/src/input.ts`, `keyboard.ts`). Text arrives through a hidden IME field placed at
the caret (#31, #127), so dead keys, IME and on-screen keyboards deliver finished text. Ctrl +
wheel first reaches the page (#167). Paste, drag and drop and uploads write files into the engine
(#125, #126, #181).

## Network

WebCore's curl backend with libcurl, nghttp2 and OpenSSL. curl believes it has normal sockets:
`socket`, `connect`, `send`, `recv`, `poll`, `getaddrinfo` and friends are wrapped at link time
(`engine/src/Sockets.cpp`, #68); buffers and waiting live in WASM. Only open, send and close go to
the main thread (`engine/js/sockets.js`), which calls `Module.blTransport` (the `Transport`
passed to `createBrowser`). Incoming data is written straight into the buffer; at most 8 MB are
in flight and `onsent` gives backpressure. `getaddrinfo` returns placeholders, the relay
resolves names. A `CloseReason` becomes an errno and then a curl code (patch 0039), which picks
the error page (#174, #175).

TLS happens inside the engine, so the relay only sees encrypted bytes. On the network the engine
looks like Safari 26 (#283; patch 0057 with `platform/wasm/NetworkFingerprintWasm.cpp`, curl patch
`deps/patches/curl/0002`), because bot managers compare that with the user agent: Safari's cipher
suites (ChaCha20-Poly1305 first, #65), groups with key shares for X25519MLKEM768 and X25519,
signature algorithms, `status_request`, SCT and zlib certificate compression, so the ClientHello
has Safari's JA4; HTTP/2 with Safari's SETTINGS, windows and pseudo-header order (Akamai
fingerprint); request headers in Safari's order with its `Accept-Language`, `Priority` (urgency
from the load priority) and `Accept-Encoding`. OpenSSL has no GREASE and its own extension order,
so JA3 differs; the TCP/IP fingerprint is the relay's. All loaders share one request path (`LoaderStrategy.cpp`: cookies, at most 20
redirects, CORS and CSP for pings). curl keeps 64 connections, 6 per host (#176). The HTTP cache
stores responses in the host's Cache API (`<namespace>-http-v<format>`, #70, #182), partitioned
like Chrome's HTTP cache (#213): every entry belongs to the top site, the frame site and whether
it is the document of a subframe (`HttpCache::partition`). The top site comes from the origin of
`firstPartyForCookies` (a `blob:` top: its creator), the frame site from the origin that loads
(the resource's origin: document or worker) or, for a navigation, its target. So workers use their
storage key: service and shared workers load through the placeholder document of their own page,
whose `firstPartyForCookies` is the top origin of the registration or creator, dedicated workers
through their creator's document. A load WebCore made opaque (CORS after a cross-origin redirect)
takes the frame's context instead: the worker of a worker page or the document. Opaque contexts
(sandboxed frames, `data:` tops) and origins without a site (`file:`) are not cached. WebKit's
memory cache stays shared by all views of the engine. HTTP authentication (#257, `HttpAuth.cpp`):
curl answers Basic and Digest itself once it has a user name and password; the credentials of the
session are kept per protection space (host, port, scheme, realm) in WebCore's `CredentialStorage`
and sent ahead for Basic in the same directory, a 401 without them asks the host (`auth`). Range requests (the pieces of `MediaFetch`,
`fetch()` with `Range`) are cached like Chrome's sparse entries (#222): a 206 with a strong
validator is stored as a range of its resource (resources up to 10 MB), and a range request is
answered once the ranges of the newest version (validator and Vary values) cover the whole
resource; another version replaces the ranges. `MediaFetch` looks up in the partition of the
element's document. A 304 only updates the headers of the stored entry, its body stays in the
Cache API.

## Storage

The engine uses WasmFS. `/data` is the OPFS directory `<namespace>` of the host origin
(`engine/src/Storage.cpp`, `engine/js/wasmfs-opfs.js`), so data survives reloads. Only one
browser per namespace owns it (Web Lock `<namespace>-data`); another tab runs with `/data` in
memory and gets the `storage-locked` warning. With `storage.persistent: false`, or without OPFS
(node tests), `/data` is in memory.

| Under `/data` | Owner |
|---|---|
| `cookies.db`, `localstorage/`, `indexeddb/` | WebCore and `WebKitLegacy/Storage` through the MemoryVFS (#67, #180) |
| `cachestorage/` | Cache API of the pages (#105, #155) |
| `serviceworkers/` | Service worker registrations (#105) |
| `opfs/<origin>/`, `opfs-swap/` | OPFS of the pages (#95, #166) |
| `tmp/` (incl. `tmp/uploads/<view>/`) | Atomic replacement and uploads, cleared at start (#142, #181) |

Read-only files outside `/data`: `engine.data` (Noto Sans regular and bold, fontconfig with its
cache, CA list) in memory, and `/lazy`, files of `lazy/` next to the engine that load on first
use: `/lazy/icu`, the ICU data beyond the core linked into `engine.wasm` (`engine/icu-core.txt`,
#228), and `/lazy/fonts`, Noto Serif, Mono, the italics, more scripts, symbols, Chinese,
Japanese, Korean and emoji (#229). `LazyFiles.cpp` lists them from an index (sizes, so `stat`
needs no request) and fetches a file whole with a synchronous request on its first read, so only
pages that need a locale, collation, dictionary, charset converter or font download it.
fontconfig's cache in `engine.data` already describes every font of `/lazy/fonts`, so finding a
font for a character reads no font file; Chinese, Japanese and Korean are cut into the slices of
Google Fonts (most frequent characters first, about 30 KB each with Brotli), emoji into the
Unicode emoji groups and the symbol fonts into Unicode blocks. Files usually needed together are
a group (a CJK font's most frequent slices, the data of an ICU locale): the first read fetches the
others in parallel. Once the engine runs it fetches the files of `engine/lazy-prefetch.txt` and
the ICU groups of the user's languages in the background (#240). The first read the layout waits
for scans the rendered text and fetches the fonts and dictionaries it needs side by side (#252);
fonts only reached as a fallback for characters (scripts, CJK, emoji) hold up the engine thread at
most 300 ms, the text is laid out again once they are there (#255).

SQLite databases live in WASM memory (MemoryVFS, 64 KB blocks) and are written to disk as one
file with the WAL folded in, about 1 s after a change and on page hide (#180). IndexedDB is
limited to 256 MB per origin for writing (#179).

## Media

```
page <video src>  -> MediaPlayerPrivateWasm --create--> host <video src=bl-media/...>
                     MediaFetch (curl, Range) <-------- service worker (media-sw.js, 2 MB chunks)
                     hole in the page (compositor) -place-> host <video> behind the view canvas
                     or paints the frame     <--------- frame copied into engine memory
```

`MediaFetch` loads http(s) with the shared loader, `blob:` and `data:` from memory. MSE: WebCore
gets tracks and timestamps from own fMP4/WebM parsers (`ContainerParser`) and the same bytes go to
a host MediaSource that decodes (#48). With compositing the host shows its own `<video>`
(#232): the video gets a composited layer whose contents is a hole punch buffer (patch 0047), the
compositor clears that rect in the framebuffer (its WebGL context has alpha) and
`VideoOverlay.cpp` sends the transform of every hole after a shown frame ("place"); the core puts
the host `<video>` before the view canvas (`position: relative`) with that transform, so page
content over the video stays on top and clipping comes from the hole. Frames are copied only
while the page reads them (`drawImage`, WebGL, `VideoFrame`), `requestVideoFrameCallback` gets
the presented frames of the host (`bl_media_presented`). A hole the compositor cannot punch
straight into the framebuffer (opacity, blend mode, color filter, perspective, inside the
offscreen surface of an effect) is refused and that player goes back to copied frames painted
into the tiles (#217), as do all players with `BL_VIDEO_OVERLAY=0` or without compositing. Sound
comes straight from the host element. WebCodecs, MediaStream, MediaRecorder, WebRTC and Picture-in-Picture use the host's
implementations (#107, #113, #114, #117 to #119); the corresponding services must be enabled.
Where the host has no `MediaStreamTrackProcessor` (Firefox), camera, microphone and screen reach
the engine through a stand-in (`track-reader.ts`): a hidden `<video>` gives `VideoFrame`s, an
AudioWorklet `AudioData` (#259).

## Audio

Web Audio renders on the engine thread "WebAudio Wasm" about 64 ms ahead into a ring buffer in
shared memory; the core's AudioWorklet (`audio-worklet.js`) reads it without locks and plays it
(#41). Until the first user gesture the engine keeps rendering at clock speed and drops the
sound, so `currentTime` advances like in a normal browser. `decodeAudioData` uses the host
decoder (#42). The ring layout is in [engine/README.md](../engine/README.md).

## WebAssembly of the pages

JSC's C loop cannot run WebAssembly, so page modules run in the host's WASM engine at full speed
(#56): `engine/js/wasm-guest.js` rebuilds the `WebAssembly` API inside JSC (evaluated on first
access), `engine/src/wasm/WasmBridge.cpp` passes values, and `engine/js/wasm-host.js` runs the
modules in the engine worker. `engine/js/wasm-rewrite.js` rewrites every module so each memory is
a bounds-checked region of engine memory and `memory.buffer` is a normal ArrayBuffer (#57, #58,
#152); this costs about 10 to 15 % speed. Limits: 2 GB per memory, 64 nested JS/Wasm calls, no
shared memory or JSPI (#153). Page workers run from the host event loop so finalizers fire (#183).

## Garbage collection

JSC's GC is conservative and scans the stack, but WASM locals are invisible to it. Instead of
spilling all pointers (#17, 14x slower) the engine runs the GC only on an empty stack: every
engine task runs under `DeferGC`, and explicit requests wait for the outermost one (patch 0012,
#36). During long scripts the heap sets a VM trap that the interpreter serves at instruction
boundaries where all values are in memory (#60, #72, `engine.safepointGC`). Proof:
`tests/engine/gc-test.mjs` with `JSC_slowPathAllocsBetweenGCs=10`.

WASM memory never shrinks and grows up to 4 GB, in a 32 bit browser only to about 1 GB. One build
serves both: `engine/src/MemoryWatch.cpp` runs after every engine task and acts when malloc's
footprint grew by 32 MB. Above 192 MB it calls `WebCore::releaseMemory` (#61, #64). Once the
malloc area ends above 384 MB it grows the memory ahead so that 128 MB stay free above it; when
that fails, the current size is the limit. From then on, or above 3 GB, it reports
`memory-pressure` `{footprint, limit}` at every growth, and the host discards background views
(#128, #171, #216).

## JavaScript

JSC runs the C loop interpreter (`ENABLE_JIT=OFF`). Patches turn on the interpreter's call
caches on 32 bit (#62), add caches for `instanceof` and missing properties (#143) and leave mini
mode off (#122). Scripts are compiled to bytecode on every visit: a persistent bytecode cache
brought no measurable gain and was removed (#215).
