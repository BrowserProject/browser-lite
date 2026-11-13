# Architecture

How browser-lite is built, from the engine artifact up to the demo. Numbers like #142 refer to
[decisions.md](decisions.md).

## Layers

```
 your page / apps/demo          tabs, address bar, settings (only public package APIs)
   |
   |  @browser-lite/ui          unstyled handlers: select and datalist lists, pickers, prompts, menus
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
| Extensions | `packages/core/src/extensions`, `packages/ui/src/slots.ts` | Plugins of the integrator: request handler chain, scripts and CSS in pages (isolated worlds, `engine/src/UserContent.cpp`), UI slots ([extensions.md](extensions.md)) |
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
(`engine/src/`). The service worker server talks to its pages and workers through the RunLoop
like WebKit2's IPC: every message, also the reply to a request, comes after the ones sent before
it (#103, #483). Like WebKit2's, the page a service worker or shared worker runs in has no
sandbox, so its placeholder document, which the worker's loads are checked against, has the
worker's origin (#484). The workers share the engine's process, so a service worker that does
not stop within WebKit's 10 s (blocked in the host, in WebAssembly or a RegExp, where termination
cannot reach it) is given up instead of ending the process: its thread is left to run, the server
counts the worker as ended and can start it again (patch 0111, #512); its events still pending end
with it, so a waiting worker can activate (patch 0112). A new port needs an entry
in `ALL_PORTS`, `Source/cmake/OptionsWasm.cmake` and a `PlatformWasm.cmake` per project (patch 0006). All WebKit changes are patches in
`engine/patches/` ([build.md](build.md)). WebKit's UI strings with placeholders (validation
messages, the file input's "2 files", time labels of media controls) are formatted with WTF's
`StringPrintStream` (`vsnprintf`, also positional `%1$d`) and take the same UTF-8 texts as the
GLib ports (patch 0076, #363). Layout lays a box with a percentage height out again only when
what its percentages resolve against changed, not on every layout of its parent or of the block
they resolve against, and a flex item with such descendants only after it was measured in the
same layout (patch 0098, #461). A cell at the left or right edge of a table with collapsed borders
paints its background inside the widest border half at that edge, which the table works out once
until its collapsed borders change (patch 0106, #485). The balancing passes of a multicol (one
column set, no spanners, not inside another fragmentation context) keep the layout of a block
whose last layout met no column boundary and no forced break and that still lies strictly inside
one column, like Blink's legacy layout; they lay out only what meets a column boundary again
(patch 0118, #519). A rule that `insertRule()` adds to or `deleteRule()` removes from an active
sheet restyles only the elements it may match, like a sheet that was added (WebKit restyled the
whole document; CSS-in-JS libraries insert hundreds of rules while a page renders), unless
something else of the sheets changed or the rule is no style rule (also inside `@media`); the
style resolver is still built anew. Such a new resolver keeps the faces of the `@font-face` rules
whose descriptors did not change, where WebKit made every face anew, which loaded its font again
and so restyled and laid out the whole document once more (patch 0124, #530). `CompressionStream` and
`DecompressionStream` take every `BufferSource`, also one of another realm such as an iframe's
`Uint8Array`: WebKit's builtin refused chunks that failed `instanceof ArrayBuffer` of its own
realm, now the WebIDL conversion of the encoder and decoder checks them by brand (patch 0110, #506).
`performance.timeOrigin` is turned into wall clock time once, when the `Performance` object of a
page or worker is made, and reads the same ever after like in Chrome and Firefox. WebKit turned it
at every read (origin minus monotonic now plus wall now); the wall clock of the build is
`Date.now()` in whole milliseconds, so the value moved between two neighbouring milliseconds, a
difference fingerprinting scripts see (patch 0134, #547).

The view events of a load come from our `FrameLoaderClient` (`engine/src/Clients.cpp`):
`navigation-start` and `navigation` (`loading` true) when the main frame starts a provisional load
(#494), `commit`, then `navigation` and `title` of the new document. A page from the back/forward
cache commits while the frame still holds the page being left, so its `navigation` and `title` follow once it is
back in the frame (`didRestoreFromBackForwardCache`, #367). Until the commit the engine reports
the address of the document being left; the address a navigation of the host goes to is kept by
the core (`View.pendingURL`, `packages/core/src/pending.ts`, #382). The core also reads typed
text like Chrome (`typedAddress`, `packages/core/src/address.ts`, #435): without a scheme
`https://`, after a `network` or `certificate` error page of that load `http://`, and `http://`
right away for localhost, IP addresses, names without a dot and other ports; the engine gets the
full address.

`:visited` asks the `VisitedLinkStore` of the page; the page configuration of a bare `Page` has
WebCore's empty one, which answers "not visited" for every link. All views share the engine's own
store (`engine/src/VisitedLinks.cpp`): WebCore's `HistoryController` adds every address a frame
commits, the host adds its history with `browser.addVisitedLinks` and empties the store with
`clearVisitedLinks` (`bl_add_visited_links`, `bl_clear_visited_links`). It keeps only the shared
string hashes of the addresses, like the stores of WebKitLegacy and WebKit2, and a new entry
restyles the links to it in the open documents; a document from the back/forward cache resolves
its style again when it comes back. WebCore limits `:visited` to colors and makes
`getComputedStyle` and painting APIs report the unvisited style (#480).

## Threads

Emscripten pthreads need `SharedArrayBuffer`, hence cross-origin isolation
([embedding.md](embedding.md)). Every pthread is a Web Worker running `engine.js`.

| Thread | Does |
|---|---|
| Page main thread | Core: DOM, input, events, host calls (media, capture, devices), transport, frames without compositing |
| Engine thread (`main()`, `-sPROXY_TO_PTHREAD`) | WebCore and JSC for all views, the event loop (`EngineLoop.cpp`), every `bl_*` export |
| Compositor | Composites layers with its own WebGL 2 context into the view canvases it owns (#98) |
| Scrolling | WebCore's scrolling tree; wheel and swipe go there through the compositor (#101), a swipe without a DOM wheel event (#314), smooth scrolls of the page run on the compositor's ticks (#366) |
| Tile painters, image decoder, curl, IndexedDB, Web Audio, page workers | Background work; 8 pooled workers plus 4 loaded in reserve (#242); a worker whose `engine.js` did not load is replaced, one at a time (#543) |

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

All views share one engine thread. The core watchdog emits `unresponsive` when input or an
expected answer gets no reply within 10 s (#147, #172). The engine stops a JS entry once the host
has waited 30 s for it (`scriptTimeoutSeconds`, #146); the core tells it in shared memory whether
it waits (`bl_host_wait_address`), and the user's "wait" (`keepWaiting()`) gives the script the
whole limit again. A script nobody waits for runs to its end, like in Chrome (#501). A page dialog holds only its page: until the answer the engine thread
runs the other views in a nested event loop (`runNestedEventLoop`, #258). The question before a
form is sent again waits without a nested loop: the navigation policy answers later (#369). Input to a visible view
makes the hidden views without sound wait like the pages below a dialog (timers, tasks, scripts,
parser and loads held; also the timers of style and layout, the load events of images, links and
style elements, a parser that pumps while suspended and the hit test for the element under the
mouse after a layout, patches 0125 to 0127 and 0131) until no input came
for 1 s, after keys or text while the focus stays in a text field for up to 10 s, while a visible
view loads a new page until it commits, and after a view became visible (a switch of tabs, urgent
like input) until it made the frame that was due, which comes before its own waiting tasks
(`HiddenViews.cpp`, #364, #394, #419, #531, #537), so a heavy page loading in a background tab does not
hold up typing in, loading or switching to the front one.

## Frames

Each view canvas is transferred to the presenter worker (`transferControlToOffscreen`, #83).
Skia rasterizes with Ganesh on WebGL 2 in the engine worker (#86); without WebGL 2 or with
`engine.gpu: false` on the CPU, where patch 0020 lets Skia use SSE4.1 mapped to WASM SIMD.
Compositing follows WPE's Coordinated Graphics (`LayerTreeHostWasm.cpp`): the engine thread
updates and flushes, tile threads paint, the compositor thread composites, so `transform` and
`opacity` animations and scrolling continue while JS blocks (#94, #98). Blur and shadow run on
the GPU with cached filtered layers (#156); `url()` and SVG filters on the CPU. Damage tracking
like WPE (`ENABLE_DAMAGE_TRACKING`, #220): the layers report what changed, a frame without a
visible change is neither composited nor shown. A frame whose damage touches at most 16 damage
tiles of 128 CSS pixels and half of the view is composited only into those tiles, each into
a small canvas of its own over the view canvas, which keeps its last frame (`DamageTiles.cpp`,
`view-tiles.ts`; the host browser repaints a canvas whole for every new frame, so a spinner cost a
whole view per frame before); other frames composite the whole view and empty the tiles (with a transparent bitmap of 1x1 pixels: after `transferFromImageBitmap(null)` Safari 18 keeps showing the tile's last frame, #463).
A layer that only animates its opacity and transform (pulsing skeleton placeholders, Wikipedia's
pulsating dot) is shown by the host browser itself once it stood still for about 20 frames
(`HostLayers.cpp`, `view-host-layers.ts`, patches 0104 and 0117, #478, #518): a canvas of its own
over the view canvas and the tiles, drawn once by the compositor (a scaling layer at the largest
scale of its animation, like Chromium rasterizes it), whose opacity and transform the host runs as
a Web Animation sampled from the engine's animation and started at the same time, so its animation
needs no frame of the engine. Only leaves without effects under ancestors without effects, drawn
axis aligned, whose animations run on one timeline, qualify (WebKit adds one animation per property
of a CSS animation; patch 0132 starts those a layer gets in one commit on one clock reading); a
transform only if it scales and moves without leaving the layer's clip.
Plain leaves drawn after such a layer over where it may show (its covers: no animation, no effect
but a mask, such as an icon over a pulsing dot) go into a cover canvas right above its canvas, and
the view draws them only outside that area; any other later layer there keeps it in the frames. A
frame takes such a layer into its canvas and out of the view (or back) in the same task of the
worker, so the host shows both together; it goes back as soon as it or a cover moves, is clipped
differently, gets covered otherwise, its animation changes or the view gets a new size. The compositor's answer that a rendering update is shown (and the presenter's that
a frame is) is urgent work on the engine thread like input (see Input), so a busy page still gets
a frame every task or two (#359). At most one RunLoop pump waits among the engine's local tasks, so a
pass of them returns to the JS event loop, where the host's frame calls arrive, after one RunLoop
cycle (#477). A view without a rendering update for two stall checks (2 s
apart, `WebView.cpp`) logs where it and its compositor stand (`stallState`), with the
compositor's phase and how long it lasts, since the scene started if it never ran (#402). Pinch zoom scales the shown tiles on the compositor and commits once at the end
(#150). After GPU loss the engine paints on the CPU and returns to the GPU on restore (#157).
A layer gets tiles as far down as layout reaches (LayoutUnit, about 33.5 million px): its visible
rect is no longer clamped to 2^24 px (patch 0081, #409).
Tiles cover the visible rect of a layer and half a view around it (WPE). A rendering update waits
only for the tiles in view that already showed something; tiles out of view, and new tiles while
the view moves, are painted after them (at most one per tile thread ahead of a rendering update's
tiles) and each shows when it is done. While a layer's visible rect moves, the tiles where it gets
within 1 s at its speed (at most 2.5 views ahead) are made at once, so a fling on a page whose
scripts hold the engine thread for long stretches stays painted (patch 0097, #460).
Each view's layer tree host has its own painting engine and tile threads, whose jobs tell the
host through their layer when a tile is done. When a view closes, the engine goes first and waits
for the jobs it started (they finish without painting, queued tiles ahead are not painted), then
every layer that still names the host, attached or not, forgets it (patch 0113, #514).
A view hidden for 10 s releases its tiles, like Chrome for background tabs: its layers drop their
backing stores and the compositor their textures, which go back to WebKit's texture pool and are
deleted 3 s later (patch 0116, #517). In a browser without a GPU of its own (SwiftShader,
integrated GPUs) they are system memory of its GPU process. Shown again, the view keeps its last
frame until the rendering update that paints them again is complete; the compositor shows no frame
of it before. The memory report (`bl_memory_report`) prints the compositor's texture and Skia cache
bytes.
A layer whose filter the compositor applies leaves the filter outsets out of its bounds only when
nothing of its contents reaches further: what the contents paint outside the box (text-shadow,
shadows and outlines of children) stays in the layer (patch 0089, #442).
Images decode with WebKit's own decoders: PNG, JPEG, GIF, WebP, BMP, ICO and AVIF (libavif with
dav1d, on one thread and without assembly). AVIF matters because the engine sends Safari's user
agent and Safari has taken AVIF since version 16: sites that choose the format by user agent send
it (AliExpress), and images are requested with `image/avif` in Accept like Safari (#447).
An AVIF image learns its size and frame count from the container alone (`avifDecoderParse`), so
an image that is never painted holds its data and the parsed boxes, not a dav1d decoder and a
decoded picture; the reader does not hold its decoder, which owns it, so both go with the image
(patch 0107, #488).
A JPEG drawn at half its size or smaller decodes at 1/2, 1/4 or 1/8 (WebKit's subsampling level,
libjpeg-turbo scales in the DCT, patch 0054), drawn larger later it decodes again (#270).
The decoded frame of an image that is the contents of a compositing layer stays while the layer
holds it: the memory cache's pruning skips it, as dropping it frees nothing and the layer's next
update would decode it again on the engine thread (patch 0086, #432).
Without a transferable canvas the engine hands pixels in shared memory (`onEngineFrame`).
The core shows a frame pixel for pixel at the view's pixel ratio from the top left of the canvas
(`object-fit: none` in a box of ratio times the view, scaled back with a transform, `view.ts`):
after a rotation or an on-screen keyboard the last frame stays unscaled, cut off or with an empty
rest, until the engine shows one of the new size, like Chrome (#404). A view takes the size of its
container; the demo keeps its page area's size while one of its own fields has the on-screen
keyboard, so only a page field makes the page smaller and gets laid out again (#444).

## WebGL

ANGLE is not built: a small shim in `platform/wasm/angle/` (patch 0016, generated by
`tools/gen-angle-shim.py`) forwards WebKit's ANGLE calls to Emscripten's GLES, a real host WebGL
on an OffscreenCanvas in the engine worker (#51, #53). WebGL 1 pages get a WebGL 1 context, WebGL 2
pages a WebGL 2 context; the host browser validates the shaders. Chrome allows only 4 active
contexts per worker, so all contexts share one host context per WebGL version (#54). Every query of
the host context is a synchronous round trip to the GPU process, so `ANGLEShimWasm.cpp` never
reads the state back: wrappers of the host context's setters record what each context sets
(slots: what it sets and the call that sets it again, per draw buffer values of
`OES_draw_buffers_indexed` apart, a deleted object leaves its bindings). A switch replays the
slots of the other context and sets the initial value of every slot only the previous one had
(texture units, constant vertex attributes, uniform buffer bindings, extension switches); it asks
the host only for the pending errors (#115, #449). Each context has its own default VAO and
transform feedback object, so no page sees another page's data. After each frame `GraphicsContextGLWasm` reads the
pixels with `readPixels` into the page or, with compositing, into a layer. A lost context reports
`webglcontextlost` at its next `clear` or draw, never synchronously from `makeContextCurrent`
(WebGL often holds `objectGraphLock` there, #157).
`WEBGL_debug_renderer_info` names the GPU the host browser tells its own pages about (its
unmasked vendor and renderer, read once per host context; patch 0108): pages choose their
renderer by it, Google Maps for example leaves WebGL to a software renderer like SwiftShader
(#496).
Like ANGLE, packed depth stencil (and in WebGL 2 24 bit depth) is on from the start, so a
drawing buffer with depth keeps its stencil (patch 0122).
Workers have WebGL like in Chrome and Firefox (#528): every engine thread is a Web Worker of the
host, so a dedicated, nested or shared worker gets its host contexts on its own thread
(`engine/src/WorkerGraphics.cpp` is the worker client WebCore asks for them); all state of the
shim is per thread. A worker's thread releases its host contexts with its last WebGL context
(`WEBGL_lose_context`, patch 0120): the Web Worker runs other threads afterwards. Service workers
have OffscreenCanvas but no WebGL (WebCore gives them no worker client). A canvas handed to an
OffscreenCanvas (`transferControlToOffscreen`) shows each committed frame as its layer's contents
(patch 0121: the first commit without a frame kept the layer's display pending and swallowed the
flush of every later frame).

## Input

Mouse, wheel, touch, touchpad pinch and keyboard go from the canvas to `bl_*` exports
(`packages/core/src/input.ts`, `keyboard.ts`). Text arrives through a hidden IME field placed at
the caret (#31, #127), so dead keys, IME and on-screen keyboards deliver finished text. The field
keeps the text the input method entered since the caret last moved otherwise (a key, a click, a
new field), and every change of it reaches the page as Backspaces and inserted text, so an
Android keyboard's Backspace and suggestions, which edit that text, work after typing (#411). In Chrome
the core opens the on-screen keyboard after a tap by focusing that field again once it has the
page field's input mode, and Chrome closes it for none (#360). iOS gives its keyboard the
field's enter key hint only at a focus, so on iPhone and iPad the core moves the focus through a
second hidden field and back when the hint changes (#392). A search field without a hint gets the
hint search like in Chrome and Safari: the IME field is a textarea, for which input mode search
alone gives Gboard's return key and the "go" key of iOS (#443). A single line field without a hint
gets next when a field of its form follows (the engine reports both in `text-input`) and go
otherwise, like in Chrome on Android, so the textarea's return key shows only for text areas and
editable elements; the Enter of that next key (no `code`, unlike a hardware Enter) moves the
page's focus to that field (`bl_focus_next_field`) instead of reaching the page. iOS gives its
keyboard's Enter the code of a hardware Enter, so there such a field gets go (#495). The iOS
keyboard's previous and next
field arrows step through the host page's fields in tab order and cannot see the page's: two hidden
fields right before and after the focused IME field catch them, and the core sends Shift+Tab or
Tab into the page; past the page's first or last element the page keeps no focus and the
host gets no `take-focus` (#423). On the
engine thread the host's calls run in their order before the engine's own waiting work, and
input (like the compositor's answers, #359) is taken in between two of its tasks and before
WebCore's timers (#365), makes WTF's
RunLoop return between two of its functions (patch 0072, #347) and WebCore's loops of deferred
and async scripts and of the page's event loop return after one item (patch 0074, #351). Hidden
views wait while the user works in a visible one (#364, see Threads). Waiting mouse moves coalesce (#350)
into one move whose `PointerEvent.getCoalescedEvents()` lists them all, each with its own position,
movement and time; every other trusted pointermove lists itself (#492).
Mouse events carry the host's pressed buttons (`MouseEvent.buttons`, which also gives
`PointerEvent.pressure`); a further button pressed or released while one is held (a host
`pointermove` with a `button`) becomes a mousedown or mouseup (#370).
When the mouse leaves the canvas (to the host UI or an overlay) the core sends a move one pixel
outside the view, like WebKitGTK: the page gets mouseout and mouseleave and loses `:hover` and
the hovered link; a finger keeps its hover (#381). A scroll after a tap hovers nothing new under
the old tap point, like in mobile Chrome and Safari: WebCore leaves out its mouse move after a
scroll while the last pointer position comes from a tap (patch 0084, #426). A finger hovers no
link for the host either: while the last mouse event came from a tap, `ChromeClient` reports no
link address and no tooltip (the `hover` event without a url, also for WebCore's hover updates
at the tap point), like Chrome on Android, until the mouse moves again (#515). When the element
under a still mouse changes (a cookie dialog appears over a link, the link goes away), WebCore's
hover update after the layout or DOM change also reports it to the `ChromeClient` like a move,
so the link address and tooltip follow like in Chrome (patch 0105, #481). A page from the
back/forward cache still knows the element (and iframe) the mouse was over when it was left, so
the first move out of it fires mouseout and mouseleave like in Chrome (patch 0079, #398).
A click focuses the button, checkbox, radio button or link under it, like Chrome and Firefox and
WebKitGTK, not like Safari on macOS, which leaves them unfocused: Space toggles a checkbox just
clicked and the page gets focus and blur (patch 0093, #450). Tab also reaches `<input type=color>`
like any other button-like control, as in Chrome and Firefox (patch 0130, #535).
On a mobile device (`device.mobile`) the overlay scrollbars of the page and of scrolling boxes
only show the position, like in mobile Chrome and Safari: they take no hit tests, so taps,
touches and `elementFromPoint` reach the content under their 21 px. On a desktop, also one with
a touch screen, they take the press and drag (patch 0082, #413).
Two fingers zoom the view (`touch-pinch.ts`) once the page answered both touchstarts without
`preventDefault` and touch-action allows it; the movement until then is kept and the zoom catches
up with it, also after the fingers lifted, so a pinch while the page keeps the engine thread busy
is not lost, like Chrome replays the queued touch moves (#505).
Tab moves the focus to links too, like in Chrome and Firefox (`ChromeClient::keyboardUIMode`, #372);
past the last element it goes back to the host (`take-focus`).
Ctrl + wheel first reaches the page (#167), and so do keys: a keydown the page does not handle
(no `preventDefault`, editing command or default action, `EventHandler::keyEvent` false) comes
back as `unhandled-key`, where the demo runs its shortcuts like Chrome; only the ones that leave or
switch the tab skip the page (#436). The engine answers every keydown (`key-result`), and like
Chrome's input router the core holds later keyboard input until it answered a keydown that may be
a shortcut, one with Ctrl, Alt or Meta or one that types no text (`key-queue.ts`): what was typed
right after Ctrl+L goes to the address bar the shortcut focused, not to the busy page (#507).
Typing does not wait, so the keys typed while the engine was busy reach it at once (#524). Escape is Stop there, after the page and the demo's own
fields (#437). Paste, drag and drop and uploads write files into the engine
(#125, #126, #181). A drag of the page sends its data to the host (`page-drag-start`); over an
element of the embedding page (the view canvas has the pointer captured) the core sends that
element untrusted drag events with the data and the page a point outside the view, and a drop
there ends the page's drag with the drop effect (`bl_drag` phase 3, `drag-out.ts`, #534). Copy and cut and the page's `navigator.clipboard.writeText()` and `write()`
put text and HTML on the engine's clipboard, which the host gets as the event `clipboard`
(handler `clipboardWrite`; the async Clipboard API through `Pasteboard::writeCustomData`,
patch 0100, #469). Copy image of the context menu (`bl_copy_image`) hit tests the menu's point
again like Chrome's `CopyImageAt` and encodes the image there at full size, turned by its EXIF
orientation, as PNG with Skia (`onEngineCopyImage`); the core hands it to `clipboardWrite` as a
promise the click already wrote, as Safari requires (#511).

## Network

WebCore's curl backend with libcurl, nghttp2 and OpenSSL. curl believes it has normal sockets:
`socket`, `connect`, `send`, `recv`, `poll`, `getaddrinfo` and friends are wrapped at link time
(`engine/src/Sockets.cpp`, #68); buffers and waiting live in WASM. Only open, send and close go to
the main thread (`engine/js/sockets.js`), which calls `Module.blTransport` (the `Transport`
passed to `createBrowser`). Incoming data is written straight into the buffer; at most 8 MB are
in flight and `onsent` gives backpressure. `getaddrinfo` returns placeholders, the relay
resolves names and connects with Happy Eyeballs like a browser (RFC 8305, #415). A `CloseReason`
becomes an errno and then a curl code (patch 0039), which picks the error page (#174, #175). Like other browsers, `CurlRequest` sends a request again on a new
connection when the pooled connection it took (kept alive, HTTP/2, preconnected) dies before any
response byte, at most twice, also with a body; one that fails on a new connection is final (patch
0078, #397). `file:` addresses read the engine file system; one without a file
and an `about:` address WebCore does not load get the error page too, from the engine's own
error codes (`LoadErrorCode` in `engine/src/LoaderStrategy.h`, #395), as does an address WebCore
refuses before any request (restricted port, address of only zeros, `refusedReason`), which
`blockedError` marks with its reason. The engine's own requests (icons, preconnect, their
redirects) skip such an address too, and an error page loads no favicon (#400). Redirects the
engine stops (more than 20, or to a `file:` address) carry their own codes and get the page under
the address that redirected (#406). Like in Chrome, a main frame navigation answered with an HTTP
error status (400 or more) and an empty body fails instead of committing an empty document:
`DocumentLoader::finishedLoading` asks the port (`LoaderStrategy::httpErrorWithoutBodyError`,
patch 0083), and the page of kind `http` says `HTTP ERROR 500` (#425). The view reports the
failure first (`error` with curl's English text, for logs), then the page commits with
`errorPage`; the page is the only message users get, the demo shows no other (#427).
An address the host loads (`bl_load_url`, typed by the user) has no initiator document: a
`data:` or `about:` document from it starts with an empty policy container (CSP, referrer
policy) like in Chrome, while one a page navigates to inherits the page's policy (HTML spec,
patch 0080, #408). A navigation whose response becomes a download (`attachment`, a type the
engine does not show) continues as the download (`continueAsDownload`, like WebKit2's
`NetworkResourceLoader::convertToDownload`): the paused request is taken from the
`ResourceLoader` before WebCore cancels it, or the body comes from the HTTP cache, so a one-time
link or a form POST reaches the server once. `<a download>`, a navigation the
engine has no load for (answered by a service worker or WebKit's memory cache), `bl_download`
(Save link as, Save image as, the demo's Download again: the page's cookies and the referrer its
policy allows, #511) and `bl_save_page` (Save page as, the main frame's address named after its
title) send a request of their own (#412).
A `view-source:` address is a document of its own like in Chrome (`engine/src/ViewSource.cpp`,
#490): the loader strategy serves the main frame's load of it from a request for the address after
the scheme (cookies of a navigation, redirects followed, the body of any status) and answers with
the text decoded like the page would be and escaped into numbered lines, sandboxed by its CSP.
WebCore keeps it in the history, so back, forward and reload come back to it. The navigation
policy lets it through only in the main frame from the host or the user (`bl_load_url`) and for
back, forward and reload; a page, a frame or a redirect cannot open it.
An XML document in the top frame without style information (no stylesheet, no XSLT, no element
of XHTML, SVG or MathML), an RSS or Atom feed for example, shows WebKit's XML tree viewer like
Chrome and Firefox: indented tags with buttons that fold them under the line "This XML file does
not appear to have any style information". WebKit runs it only with developer extras; patch 0133
runs it on the Wasm port wherever the page may run scripts, since the viewer is a script that
builds the tree at the load event (with JavaScript off the document is rendered as before, #540).
A synchronous load (a synchronous `XMLHttpRequest`, its CORS preflight, an external entity of
XML; `engine/src/SyncLoad.cpp`, #471) cannot block the engine thread, which is where curl's
answers arrive. Like a dialog (#258) it defers the page group (`PageGroupLoadDeferrer`) and runs
the other views in the nested event loop (`waitHoldingPageGroup` in `Clients.cpp`) until the load
is done, so the page sees a blocking call and the other tabs go on. It uses the HTTP cache of the
document's partition, cookies and redirects like any load; WebCore checks CORS of the result
(`DocumentThreadableLoader`) and gives it a timeout of 10 s without data. The page's service
worker does not see it, a closed view ends it, and like Chrome it is refused during unload,
pagehide and beforeunload.

TLS happens inside the engine, so the relay only sees encrypted bytes. On the network the engine
looks like Safari 26 (#283; patch 0060 with `platform/wasm/NetworkFingerprintWasm.cpp`, curl patch
`deps/patches/curl/0002`), because bot managers compare that with the user agent: Safari's cipher
suites (ChaCha20-Poly1305 first, #65), groups with key shares for X25519MLKEM768 and X25519,
signature algorithms, `status_request`, SCT and zlib certificate compression, so the ClientHello
has Safari's JA4; HTTP/2 with Safari's SETTINGS, windows and pseudo-header order (Akamai
fingerprint); request headers in Safari's order with its `Accept-Language`, `Priority` (urgency
from the load priority) and `Accept-Encoding`. OpenSSL has no GREASE and its own extension order,
so JA3 differs; the TCP/IP fingerprint is the relay's. All loaders share one request path (`LoaderStrategy.cpp`: cookies, at most 20
redirects, CORS and CSP for pings). curl keeps 64 connections, 6 per host (#176). A new HTTP/2
connection carries only the request that opened it until the server's SETTINGS announce how many
streams it allows; the waiting requests then take what the limit leaves, the rest open the next
connection (curl patch `deps/patches/curl/0003`, #479). The HTTP cache
stores responses in the host's Cache API (`<namespace>-http-v<format>`, #70, #182), partitioned
like Chrome's HTTP cache (#213): every entry belongs to the top site, the frame site and whether
it is the document of a subframe (`HttpCache::partition`). The top site comes from the origin of
`firstPartyForCookies` (a `blob:` top: its creator), the frame site from the origin that loads
(the resource's origin: document or worker) or, for a navigation, its target. So workers use their
storage key: service and shared workers load through the placeholder document of their own page,
whose `firstPartyForCookies` is the top origin of the registration or creator, dedicated workers
through their creator's document. A load WebCore made opaque (CORS after a cross-origin redirect)
takes the frame's document instead, which in a worker page has the worker's origin. Opaque contexts
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

WebSockets of the pages run over curl's sockets in `engine/src/websocket/` (WebKitLegacy's
`WebSocketChannel`, WebCore's handshake and frames). Like Chrome they offer the compression
`permessage-deflate; client_max_window_bits` (RFC 7692, `WebSocketPerMessageDeflate.cpp`,
#529) instead of WebKitLegacy's obsolete `x-webkit-deflate-frame`: once the server accepts, a
whole message is compressed with WebCore's zlib streams, with the client window and context
takeover the server asked for; a received message is decompressed after its last frame. Patch
0123 fixes WebCore's parser of the `Sec-WebSocket-Extensions` answer (it never moved past a
token, so every answer with the header failed the connection) and its inflater for a message that
ends with a final block.

The favicon of a page is loaded by the engine itself (`WebView::updateFavicon`, `loadIcon` in
`LoaderStrategy.cpp`, `data:` and `blob:` icons without a request). Like Chrome the best
`<link rel=icon>` of an http(s) page is taken as soon as the parser or a script adds, changes or
removes one (patch 0119 tells the view, which decides once per task), also after the load
(notification badges, single page apps); without one, `/favicon.ico` once the page has loaded. It
goes to the host (`icon`) once per document and icon address; the view keeps its last 4 icons, so
a page with the same icon address, or one that switches between a few (an unread badge), gets it
without a new request, and an icon that arrives after its page was left or its link changed is
dropped (#389, #520).

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

Cookies live in curl's `CookieJarDB` (SQLite). A public suffix is no cookie domain, except for the
host that is itself one (`github.io`, `httpbin.org`): like Chrome and Firefox (RFC 6265 5.3) its
cookies without a Domain attribute, or with one naming exactly that host, are kept host-only
(patch 0129, #533); before, every cookie of such a host was dropped.

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
for scans the rendered text outside Latin-1 and fetches the fonts and dictionaries it needs side
by side (#252, #485);
fonts only reached as a fallback for characters (scripts, CJK, emoji) hold up the engine thread at
most 300 ms, the text is laid out again once they are there (#255), only the elements with text
outside the fonts of `engine.data` (#401). The fonts of a cascade keep every fallback font their
cached shaped text points to, also the one for an emoji cluster, so a purge of WebKit's font
cache never deletes a font that text still paints with (patch 0087, #434).

SQLite databases live in WASM memory (MemoryVFS, 64 KB blocks) and are written to disk as one
file with the WAL folded in, about 1 s after a change and on page hide (#180), on a storage thread
from a copy on write of the database, so the engine thread never waits for the OPFS (#446). Every commit also
appends its new WAL pages to a hidden log next to it (`.<database>-bllog`) at once; opening
applies them if the log goes on from that very database file (hash), the next full write empties
the log (#302). IndexedDB is
limited to 256 MB per origin for writing (#179). A page's CryptoKeys go into it (and through
`structuredClone` and `postMessage`) serialized by `engine/src/CryptoKeys.cpp`, without a
wrapping master key, like the OpenSSL ports of WebKit, Chrome and Firefox (#527).

## Media

```
page <video src>  -> MediaPlayerPrivateWasm --create--> host <video src=bl-media/...>
                     MediaFetch (curl, Range) <-------- service worker (media-sw.js, 2 MB chunks)
                     hole in the page (compositor) -place-> host <video> behind the view canvas
                     or paints the frame     <--------- frame copied into engine memory
```

`MediaFetch` loads http(s) with the shared loader, `blob:` and `data:` from memory. MSE: WebCore
gets tracks and timestamps from own fMP4/WebM parsers (`ContainerParser`) and the same bytes go to
a host MediaSource that decodes (#48). Which types play is the engine's question only for what
it does itself (the media feature, the containers of its MSE parsers); for the codecs it asks
the host: `canPlayType` and `isTypeSupported` synchronously (common types answered ahead, #137),
`navigator.mediaCapabilities.decodingInfo` of pages and workers asynchronously with the host's
own `decodingInfo` on its main thread, so `supported`, `smooth` and `powerEfficient` are the
host's (`MediaCapabilitiesWasm.cpp`, #503). With compositing the host shows its own `<video>`
(#232): the video gets a composited layer whose contents is a hole punch buffer (patch 0047), the
compositor clears that rect in the framebuffer (its WebGL context has alpha) and
`VideoOverlay.cpp` sends the transform of every hole after a shown frame ("place"); the core puts
the host `<video>` before the view canvas (`position: relative`) with that transform, so page
content over the video stays on top and clipping comes from the hole. Frames are copied only
while the page reads them (`drawImage`, WebGL, `VideoFrame`), `requestVideoFrameCallback` gets
the presented frames of the host (`bl_media_presented`). `getVideoPlaybackQuality()` reports the
frame counts of the host element, which decodes and shows every frame in both modes (sent with
each state report); with copied frames a frame the host showed that never reached the engine
counts as dropped as well (`media-quality.ts`), so adaptive players lower the quality when the
copies fall behind (#538). A hole the compositor cannot punch
straight into the framebuffer (opacity, blend mode, color filter, perspective, inside the
offscreen surface of an effect) is refused and that player goes back to copied frames painted
into the tiles (#217), as do all players with `BL_VIDEO_OVERLAY=0` or without compositing. Copied
frames keep the alpha of transparent VP8, VP9 and HEVC videos (RGBA, not premultiplied, #442). Sound
comes straight from the host element. A hidden page pauses video without an audio track (#170),
so the host reports whether its element has one: `audioTracks` (Safari), `mozHasAudio` (Firefox),
decoded audio bytes (Chrome, #386). Muted or silent `autoplay` video plays only while it is in
the view (WebCore's `InvisibleAutoplayNotPermitted`, like Chrome and Safari on iOS): one below the
fold waits, one scrolled out pauses and plays on when back; `play()` from a script and a start
during user activation lift the rule for that element (#399). WebCodecs, MediaStream, MediaRecorder, WebRTC and Picture-in-Picture use the host's
implementations (#107, #113, #114, #117 to #119); the corresponding services must be enabled.
Where the host has no `MediaStreamTrackProcessor` (Firefox), camera, microphone and screen reach
the engine through a stand-in (`track-reader.ts`): a hidden `<video>` gives `VideoFrame`s, an
AudioWorklet `AudioData` (#259). A `<video>` in fullscreen shows its whole picture like the native
players of phones (`video:fullscreen { object-fit: contain !important }` only for the WASM port in
WebKit's `fullscreen.css`, patch 0101, #474): m.youtube.com fullscreens its `<video>` for the
iPhone it sees and keeps its own `object-fit: cover`. The media controls (WebKit's modern media
controls with the Adwaita layout) take their icons from WebCore itself: patch 0103 compiles the
Adwaita images into it (`Scripts/generate-media-controls-images.py`), GTK and WPE read them from
a GResource. The player supports element fullscreen (`MediaPlayerPrivateWasm::supportsFullscreen`),
so the controls show their fullscreen button inline and the exit button in fullscreen, and
`webkitEnterFullscreen()` works (#476).

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
boundaries where all values are in memory (#60, #72, `engine.safepointGC`), also inside the VM
entries of the JIT's generic calls (patch 0090, [jit.md](jit.md)) and of a bound function's call
of its JS target (patch 0115, #516: React's scheduler runs a whole render through one). Trap
checks of C++ code leave the CodeBlocks alone while the heap waits for such a safepoint (patch
0114: JSC walked all of them for breakpoints that only signal based traps install). The heap
grows like JSC's on a machine with less than 16 GB (patch 0091: the threshold of the aggressive
mode wrapped to 0 in 32 bits, so its rate limiting let up to 256 MB of garbage pile up in one
burst, #448). Proof: `tests/engine/gc-test.mjs` with `JSC_slowPathAllocsBetweenGCs=10`, also for
the garbage of a generic call of compiled code and of a bound function's call.

All sites share one process, so a site's event loop may never run again once the user left it.
JSC's microtask queues are GC roots and WebCore drops a stopped document's microtasks only at its
loop's next checkpoint: when a document's task group stops with microtasks waiting, the loop runs
once more and drops them (patch 0077, #388, `tests/core/page-left-test.mjs`).

WASM memory never shrinks and grows up to 4 GB, in a 32 bit browser only to about 1 GB. One build
serves both: `engine/src/MemoryWatch.cpp` runs after every engine task and acts when malloc's
footprint grew by 32 MB. Above 192 MB it calls `WebCore::releaseMemory` (#61, #64), which keeps
the compiled JS of the pages (bytecode and JIT code, patch 0088, #441) and the page left last in
the back/forward cache (of up to 3) unless memory is short (`critical` below): building the code again blocked the pages for seconds, the GC ages out code that no
longer runs, and back to a page loaded again showed its top until its load was complete (#451,
`tests/core/back-cache-test.mjs`). JSC's code cache, which holds the bytecode and the sources of
every script evaluated with strong references, goes at every release and whenever a view leaves
its page (`JSC::clearCodeCache`, patch 0102, #475): kept, it held the code of every page and
frame that was gone, while the functions that live keep their code without it
(`tests/core/memory-release-test.mjs`). When views close, a full GC collects what their pages
left once no view closed for 1 s and the user does not work in a visible view (like the hidden
views wait, `hiddenViewsWaitForUser`): JSC alone learns of that garbage only at its next full
collection, and without allocations its timer waits longer the less the last full GC freed, so
10 heavy tabs closed kept 240 MB of JS heap and their documents for minutes
(`tests/core/closed-view-gc-test.mjs`). An abort signal whose context has stopped (its document
was closed or left, its worker ended) is kept only by references, no longer by its abort
listeners, as nothing can abort it any more (patch 0128, like Chrome): a timeout, an
`AbortSignal.any` or a Request's signal with a listener whose closure held its controller or
document kept that whole page for good (`tests/core/abort-signal-gc-test.mjs`). Once the malloc area ends above 384 MB it grows the
memory ahead so that 128 MB stay free above it; when that fails, the current size is the limit.
From then on, or above the budget of 3 GB, it reports `memory-pressure` `{footprint, limit,
level}` at every growth, and the host discards background views (#128, #171, #216). On iPhone
and iPad a growth never fails, iOS ends the whole web content process instead, so the core sets
the 3 GB of `BL_MEMORY_PRESSURE_MB` to 512 MB there (#358). Memory is short, level `critical`,
with less than 128 MB left below the limit, or above the budget when less than that is free
inside the malloc area after a release that kept the code and the page left last; then a second
release drops them too. Otherwise the level above the budget is `moderate`: the footprint never
shrinks, and after one heavy page most of it is free again (#497).

Above 2 GB a wasm32 pointer is a negative `i32` in JS. Emscripten makes the pointers of its own
library functions, of `EM_ASM` arguments and of `malloc` unsigned and rewrites direct `HEAP*[p]`,
`subarray` and `set` accesses, but not the parameters of `EM_JS` functions, and `slice(p, ...)`
with a negative `p` counts from the end of the memory. So every `EM_JS` function starts with
`p >>>= 0;` for each of its pointer parameters (`tests/contract/pointers-test.mjs`), and glue that
computes an index from a pointer shifts with `>>>` (#465, `tests/core/heap-above-2gib-test.mjs`).

## JavaScript

JSC runs the C loop interpreter (`ENABLE_JIT=OFF`). Patches turn on the interpreter's call
caches on 32 bit (#62), add caches for `instanceof` and missing properties (#143; not on objects
whose structure does not list all own properties, such as module namespaces, #431) and leave mini
mode off (#122). Scripts are compiled to bytecode on every visit: a persistent bytecode cache
brought no measurable gain and was removed (#215). A JIT to WebAssembly compiles hot functions
(on by default, [jit.md](jit.md)).
Regular expressions have no JIT here: the Yarr interpreter measures each pattern and hands those
that cost much per character of their input to a RegExp of the host's worker (patch 0073,
`HostRegExp.cpp`, `BL_HOST_REGEXP`, #348). The measured cost belongs to the pattern's source and
flags, so a RegExp compiled again after a GC or a memory release keeps the decision (#362).
WASM frames nest on two stacks: the shadow stack in linear memory, which JSC's limits measure,
and the browser's machine stack (about 500 KB left in a Chromium worker when a script runs), which
the browser stops in the middle of the engine's C++ when it is full. Deep recursion through C++ (getters calling getters,
proxies, `toString`, `JSON.stringify`) fills the machine stack long before the shadow stack, so
JSC's recursion checks also probe the machine stack (patch 0075, `engine/jit/MachineStack.cpp`,
#354): the page gets a RangeError instead of the engine crashing. A check asks for 94 KB
of room (#374), enough to throw and little enough for the deep scripts of Instagram or Twitch.
The probe is a WASM function with a frame that large, whose prologue alone checks it against the
browser's limit (about 0.1 us); it holds for at most 64 checks and while the shadow stack stays
within 4 KB below and 16 KB above its point, so recursions that take no shadow stack or follow a
deeper one are probed too (#500). A one-character `replace` on a
deep rope string (a string built by appending) probes too and then replaces in the resolved string
(#368). The parser and the bytecode generator take the else branches of a conditional chain
(`a ? b : c ? d : ...`, webpack's map of chunk names) in a loop, and the parser gives up at once
when out of stack instead of retrying other readings of a deep literal at every level (patch
0109, #499). Recursion through C++ (a getter calling a getter, proxies, `toString`, a `sort`
comparator) takes about 1.1 KB of machine stack per level and so stops after 300 to 550 levels
in Chromium, where Chromium's own pages reach thousands (open, [status](status.md)).
