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
it (#103, #483). WebCore calls the Cache API's connection on the thread of the page or worker
that uses it (WebKit2's only sends messages), so the engine's runs a worker's call on the engine
thread and settles its promise with a copy for the worker (#567). Like WebKit2's, the page a
service worker or shared worker runs in has no sandbox, so its placeholder document, which the
worker's loads are checked against, has the worker's origin (#484). The workers share the engine's process, so a service worker that does
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
same layout (patch 0098, #461). A transform that comes or goes on a positioned box, which has a
layer that paints itself either way, is handled like a transform that changes (and like
`translate`, `rotate` and `scale`): the overflow of its ancestors is computed again instead of a
layout of everything around it; the stacking context it makes or a `z-index` that comes or goes
on such a box only reorders the layers. Out of flow descendants whose containing block changes
move as before (patch 0153, #596). An image or other replaced box with a percentage height is a
percentage height descendant only of the containers its height depends on, up to the first one
whose height does not come from its own containing block (an aspect ratio, a stretched flex item, a
grid area), instead of every ancestor of auto or percentage height up to the body, which laid out
every such image and the chain above it again in each layout of an ancestor (patch 0154). A cell at the left or right edge of a table with collapsed borders
paints its background inside the widest border half at that edge, which the table works out once
until its collapsed borders change (patch 0106, #485). The balancing passes of a multicol (one
column set, no spanners, not inside another fragmentation context) keep the layout of a block
whose last layout met no column boundary and no forced break and that still lies strictly inside
one column, like Blink's legacy layout; they lay out only what meets a column boundary again
(patch 0118, #519). A rule that `insertRule()` adds to or `deleteRule()` removes from an active
sheet restyles only the elements it may match, like a sheet that was added (WebKit restyled the
whole document; CSS-in-JS libraries insert hundreds of rules while a page renders), unless
something else of the sheets changed or the rule is no style rule (also inside `@media`). Such a
style rule, or an `@media` rule of style rules, also goes into the rule set the document's style
resolver has, before the rule data of the next rule of its sheet (or after those of the previous
one), and the positions after it move up, so the cascade keeps the order of the sheets; WebKit
built the rule set of all sheets anew for every style update after such a change, 5 to 25 ms
each on blick.ch, about 150 times on a tap there (patch 0158). Other changes, sheets with `@import`
or a `media` attribute and shadow trees still get a new resolver. A new resolver keeps the faces of the `@font-face` rules
whose descriptors did not change, where WebKit made every face anew, which loaded its font again
and so restyled and laid out the whole document once more (patch 0124, #530). A web font that
loads or a font face that is added or removed no longer restyles the whole document from scratch
(WebKit's `Document::fontsNeedUpdate` scheduled a full style rebuild for each): the next style
resolution visits every element and gives a style whose fonts (or those of its pseudo-elements)
are no longer the ones the font selector gives just the new fonts, sharing its parent's font data
where it did before, unless one of its values depends on the fonts: lengths in `ex`, `ch`, `ic`,
`cap`, `lh` and their root variants (a new style flag, `usesFontMetrics`), `font-size-adjust`,
container queries and units, anchor functions, animations and the styles user agent shadow trees
make themselves are resolved again, and the new fonts alone count as no change for their
descendants. Like Blink, which restyles only font metric dependent styles on a font load
(patch 0148, #584). A style sheet that a script inserts (a `link` or a `style` with `@import`,
without `blocking=render`) is not render-blocking, as in HTML and Chrome: while it loads, elements
still get their style and scripts of the parser still run, and it applies once it arrived. WebKit
counted it like a sheet of the parser, so no element without a style got one until every such
sheet had arrived, and every layout a script asked for meanwhile restyled the whole document
(patch 0160, #619). A `::before` or `::after` whose matched rules declare no `content` generates
no box, so the style resolution gives it no style of its own (`getComputedStyle()` resolves one
when asked); WebKit built both for every element a rule like Tailwind's
`*, ::before, ::after { --tw-...: ... }` matches, with all their custom properties. A removed
sheet restyles only the elements the rules of the removed and added sheets may match when the
other sheets kept their order, like Blink, and the `@font-face` rules of added and removed sheets
reach the styles as a font change (the font selector tells its clients, the next style update
gives the styles their new fonts) instead of restyling every element. A new style resolver changes the font selector's
version only when its faces or palettes changed, the root's `rem` check compares its font
description and line height instead of its fonts, and an SVG text drops the measurements of its
own fonts instead of emptying the font cascade cache (WebKit's fix for metrics of bidi SVG text,
which on this port, where all kerned text takes the complex path, ran for every SVG text). Each
of the three gave every style fonts the cache no longer gives, so the next change of the root or
the body restyled the whole document and all text was measured again (patch 0173, #640). A
touch's press sets `:active` and `:hover` on the chain of the touched element and its release or
cancel clears them. A pseudo-class inside `:is()`, `:where()` or `:not()` takes the invalidation
key (id, class, attribute, tag) of the compound around it, so `.item:is(:hover, :active) .media`
looks only at the `.item` elements of the chain; WebKit keyed it on every element, and a rule
with a universal key in an ancestor compound invalidates from the top of the chain, a traversal
of the whole document for every change (edition.cnn.com). A universal pseudo-class inside
`:has()` (`.grid:has(:active) .cell`) is handled once at the innermost element of the chain,
whose ancestors are all the elements it may change; WebKit looked for them above the top of the
chain and missed them (patch 0174, #641). When only non-inherited properties of an element change
(a transform or a background color of an animation or a script, every frame), a child is resolved
again only if a rule, its inline style or its presentational hints may set one of the changed
properties to `inherit` (the rules are collected per property with the invalidation features, a
rule may match when the ids, classes and tag of its rightmost compound do); WebKit resolved every
child that inherits any property explicitly, and the reset rule
`*, ::before, ::after { box-sizing: inherit }` makes that every element, with all its rule matching
and pseudo-elements. The same holds for the `::before` and `::after` of an element whose animation
changes only non-inherited properties: they keep their style instead of matching their rules every
frame. A `::before` or `::after` that is animated itself (a pulsing placeholder) and its element
keep their styles before animations as the base of animation frames, like an animated element in
WebKit: a frame applies the animations to a copy of the base. WebKit kept no base for an element
without animations of its own and did not use the one of a pseudo-element, so every frame matched
all rules of both (edition.cnn.com, its ad slots); and a `::before` or `::after` whose animation
had just ended kept its last animated values until the next full style (patch 0181, #650). A
child without a box stays without one (only its display could change that, and a change of
the parent's display restyles all children). Selectors on the style attribute
(`[style*=...]`) are invalidated like those of any attribute, so an inline style change keeps its
fast path (WebKit matched all rules of the element again whenever a sheet had such a selector).
An attribute of an element that a `<use>` clones reaches the clones in place, like a new clone
would have it (not for a `use`, `symbol` or `svg` element, ids and references); WebKit built the
use's whole shadow tree again for every attribute, which Lottie changes every frame (patch 0175,
#642).
`CompressionStream` and
`DecompressionStream` take every `BufferSource`, also one of another realm such as an iframe's
`Uint8Array`: WebKit's builtin refused chunks that failed `instanceof ArrayBuffer` of its own
realm, now the WebIDL conversion of the encoder and decoder checks them by brand (patch 0110, #506).
`performance.timeOrigin` is turned into wall clock time once, when the `Performance` object of a
page or worker is made, and reads the same ever after like in Chrome and Firefox. WebKit turned it
at every read (origin minus monotonic now plus wall now); the wall clock of the build is
`Date.now()` in whole milliseconds, so the value moved between two neighbouring milliseconds, a
difference fingerprinting scripts see (patch 0134, #547). An intersection observer computes its
observations again only when something that may move, size or clip a target happened since its
last update: a style update, a layout, a scroll of the page, a scroller or a frame, a change of the
layout or visual viewport or the page scale, a new target, a document fully active again. Like
Blink; WebKit computed every target of every observer in every rendering update, which pages with
many observed teasers and ads and an animation frame loop paid in every frame (patch 0137, #554).

The view events of a load come from our `FrameLoaderClient` (`engine/src/Clients.cpp`):
`navigation-start` and `navigation` (`loading` true) when the main frame starts a provisional load
(#494), `commit`, then `navigation` and `title` of the new document. A page from the back/forward
cache commits while the frame still holds the page being left, so its `navigation` and `title` follow once it is
back in the frame (`didRestoreFromBackForwardCache`, #367). WebKit keeps no render tree in the cache,
so the restore builds it with the style and layout of every element; the style environment of each
restored document is refreshed right before that (`FrameLoader::open`), not after the whole restore
as in WebKit, which restyled and laid out the page a second time (patch 0172, #638). Until the commit the engine reports
the address of the document being left; the address a navigation of the host goes to is kept by
the core (`View.pendingURL`, `packages/core/src/pending.ts`, #382). The core also reads typed
text like Chrome (`typedAddress`, `packages/core/src/address.ts`, #435): without a scheme
`https://`, after a `network` or `certificate` error page of that load `http://`, and `http://`
right away for localhost, IP addresses, names without a dot and other ports; the engine gets the
full address.

A main frame navigation pauses the page being left until the answer of the new page (#337). A
failed or stopped navigation ends as soon as its own loads ended, like in Chrome (patch 0146,
#576): WebCore also waited until the page being left no longer delayed its load event, and a
script of that page whose load the navigation cancelled waits in the paused page to fire its
error event, so neither the error page nor Stop came.

`:visited` asks the `VisitedLinkStore` of the page; the page configuration of a bare `Page` has
WebCore's empty one, which answers "not visited" for every link. All views share the engine's own
store (`engine/src/VisitedLinks.cpp`): WebCore's `HistoryController` adds every address a frame
commits, the host adds its history with `browser.addVisitedLinks` and empties the store with
`clearVisitedLinks` (`bl_add_visited_links`, `bl_clear_visited_links`). It keeps only the shared
string hashes of the addresses, like the stores of WebKitLegacy and WebKit2, and a new entry
restyles the links to it in the open documents; a document from the back/forward cache resolves
its style again when it comes back. WebCore limits `:visited` to colors and makes
`getComputedStyle` and painting APIs report the unvisited style (#480).

The pages' media queries for the user's preferences come from the host: the core watches the
host's `matchMedia` for `prefers-color-scheme` (unless `colorScheme` fixes it),
`prefers-reduced-motion` and `prefers-contrast` (`packages/core/src/screen.ts`) and sends them
with the screen (`bl_set_screen`). The Adwaita theme answers WebCore's `userPrefersReducedMotion`
and `userPreferredContrast` from that (patch 0163; it read them only from GTK's settings), and a
change reevaluates the media queries of all pages, so their `change` events fire (#623).
`forced-colors` stays `none`: WebKit has no forced colors mode, and Chrome has one only on Windows.

Where the pages lie on the screen comes from the host too (#634). The host window is the window of
every page, like the top window is for a frame in a browser: `window.screenX/Y` (`screenLeft/Top`)
and `outerWidth/Height` are the host's (`bl_set_window`, at least the view's size), so the UI around
a view counts as chrome: the difference of `outerWidth` and `innerWidth` is the host's chrome plus
the embedder's UI. Input events carry screen coordinates: the core sends the screen position of a
view's top left corner with the pointer input it belongs to (`bl_set_view_origin`, the host event's
`screenX` less its `clientX`, plus the canvas's place), and the engine adds it to the view position
of mouse, pointer, touch, wheel and drag events and to `ChromeClient::rootViewToScreen`
(`engine/src/ScreenGeometry.h`); a frame's events add the frame's place like in a browser. Pointer
events from touches take the touch point's screen position (patch 0167; WebKit's GLib code used the
view position). The screen (`bl_set_screen`) has the host's `availLeft`, `availTop` (and `left`,
`top` where the host has them). With an emulated device the phone's browser window fills its screen
at 0, 0 and the view sits at its bottom, below the browser's bar. A window moved without input is
noticed at the next pointer event, resize or focus. Before #634 the engine reported the view as the
window at 0, 0 and every `screenX` equal to `clientX`, which DataDome's captcha takes for a
synthetic event.
`navigator.hardwareConcurrency` follows the host's processors with Safari's rounding, 4 below 8 and
8 from 8 on (`BL_HARDWARE_CONCURRENCY` from the host's `navigator.hardwareConcurrency`, patch 0168);
WTF's own processor count, which sizes the engine's threads, is not touched.

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
core reports it as the reason of `crash` (#218). The demo then starts a new browser in the page
with the session; Reload, a new tab or a typed address do that too and are carried out after the
start ([apps/demo](../apps/demo/README.md), #565).

All views share one engine thread. The core watchdog emits `unresponsive` when input or an
expected answer gets no reply within 10 s (#147, #172). The engine stops a JS entry once the host
has waited 30 s for it (`scriptTimeoutSeconds`, #146); the core tells it in shared memory whether
it waits (`bl_host_wait_address`), and the user's "wait" (`keepWaiting()`) gives the script the
whole limit again. A script nobody waits for runs to its end, like in Chrome (#501). A typed address,
Back or Forward that leaves the document of a page stops the page's running script within 0.1 s
instead of waiting for it, like Firefox, and keeps that page out of the back/forward cache
(`UserNavigation.cpp`, #583). Either stop ends with the outermost entry into JS, also inside a
microtask checkpoint or a task JSC runs itself (a `FinalizationRegistry` callback): the
termination does not outlive it, so the microtasks of all views go on (patch 0165, #627). A page
dialog holds only its page: until the answer the engine thread
runs the other views in a nested event loop (`runNestedEventLoop`, #258). The question before a
form is sent again waits without a nested loop: the navigation policy answers later (#369). Input to a visible view
makes the hidden views without sound wait like the pages below a dialog (timers, tasks, scripts,
parser and loads held; also the timers of style and layout, the load events of images, links and
style elements, a parser that pumps while suspended and the hit test for the element under the
mouse after a layout, patches 0125 to 0127 and 0131) until no input came
for 1 s, after keys or text while the focus stays in a text field for up to 10 s, while a visible
view loads a new page until its load event (at most 10 s), and after a view became visible (a switch of tabs, urgent
like input) until it made the frame that was due, which comes before its own waiting tasks
(`HiddenViews.cpp`, #364, #394, #419, #531, #537), so a heavy page loading in a background tab does not
hold up typing in, loading or switching to the front one. A script of a hidden view that already
runs when input, a call of the host or a compositor answer comes pauses at its next safepoint
(patch 0149, #585): the sending thread sets the safepoint trap, the engine thread runs the urgent
work in the nested event loop of dialogs while the page waits and the view holds back like below
a dialog, also through the hold, and the script goes on afterwards. Nested work sees none of the
paused frames (`vm.topCallFrame` is empty meanwhile). Not when another view shares script with
the page (a document in one of its event loops, which WebKit keeps per site, or its page group),
and not for work outside JS (style, layout, parsing, compiling a script, the GC). The script of a
cross-site frame pauses the same way while the user works in its page, like an out-of-process
frame in Chrome (`FramePause.cpp`, #589), once it has run for 100 ms (a long task, the script
watchdog marks it and brings it to a safepoint then): a shorter one ends sooner than a pause would
help, and pausing it froze a frame with a little script per animation frame for as long as the
user typed. What pauses is its site's event loop, all documents of
it, none of which may be a top-level document, with only its frames on the stack. Its documents
are suspended, their loads deferred and their frames' scripts paused (WebCore runs no listener or
script of a paused frame, as in its debugger), the rendering update leaves out the steps that run
their script until it goes on (patch 0152). The page answers and renders meanwhile; input that
would reach the frame (focus, pointer in it or leaving it, a finger that went down in it) ends the pause and runs right after the
script, in order with later input of its view. A frame removed or left meanwhile stops its script
when it goes on. The pause lasts until no input came for 1 s, but while input keeps coming at most
500 ms: then the script runs a slice of 100 ms (a safepoint request ends it) before it may pause
again, so the frame's script, its loads and with them the page's load event go on while the user
taps or types through a load (#628). The compositor's answer for a frame is urgent too, but no
work of the user: no frame's script pauses for it (#635; without layers every animation frame
brings one, and Cloudflare's challenge paused at each and never finished).

## Frames

Each view canvas is transferred to the presenter worker (`transferControlToOffscreen`, #83).
Skia rasterizes with Ganesh on WebGL 2 in the engine worker (#86); without WebGL 2 or with
`engine.gpu: false` on the CPU, where patch 0020 lets Skia use SSE4.1 mapped to WASM SIMD.
The presenter is the compositor thread, also without WebGL 2: it then has no GL context and
puts the frames the engine thread painted on the CPU into the view canvas (#635). So the browser
reads a view canvas (a screenshot, a tab preview, `drawImage` on the main thread) without waiting
for page script on the engine thread; Firefox held its main thread up to 10 s on such a read of
a canvas whose worker was busy and then got an empty canvas. Only `engine.compositing: false`
leaves the canvases to the engine worker.
Compositing follows WPE's Coordinated Graphics (`LayerTreeHostWasm.cpp`): the engine thread
updates and flushes, tile threads paint, the compositor thread composites, so `transform` and
`opacity` animations and scrolling continue while JS blocks (#94, #98). Blur and shadow run on
the GPU with cached filtered layers (#156); `url()` and SVG filters on the CPU. Damage tracking
like WPE (`ENABLE_DAMAGE_TRACKING`, #220): the layers report what changed, a frame without a
visible change is neither composited nor shown. A frame whose damage touches at most 16 damage
tiles of 128 CSS pixels and half of the view is composited only into those tiles, each into
a small canvas of its own over the view canvas, which keeps its last frame (`DamageTiles.cpp`,
`view-tiles.ts`; the host browser repaints a canvas whole for every new frame, so a spinner cost a
whole view per frame before). Damage that keeps coming at one place over two tiles or more a frame
(a pulsing ad placeholder over 12 tiles, a spinner on the corner of 4) gets a region instead, one
canvas fitted to the damage of its last 16 frames, since every canvas costs the host about the
same per frame however small it is (#574). The compositor draws all tiles and regions in one
size of its WebGL canvas, the bounding size of the tiles of the last 2 to 4 seconds, each in the
top left corner, which is what its host canvas shows (`object-fit: none`): every new size of the
WebGL canvas reallocates its drawing buffer, which two regions of other sizes did twice a frame
(#657). Tiles and regions may overlap, and every one that
shows something shows the view as it is: a frame draws again each one its damage touches, or
empties it when the canvases of the frame cover all of it where the view canvas is out of date. A
frame whose tiles touch the hole of a video the host shows (see Media), in
this frame or in the last whole one, is shown whole too, while videos elsewhere in the page leave
the tiles alone (#550); other frames composite the whole view and empty the tiles (with a transparent bitmap of 1x1 pixels: after `transferFromImageBitmap(null)` Safari 18 keeps showing the tile's last frame, #463).
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
cycle (#477). A long cycle is one long task of the page, not many short ones, so a cycle has no
time budget of its own (#551). Every step of the engine thread over 50 ms, from its JS event loop
back to it, is in the debug log as `RunLoop step took N ms`, with its kind when it is no RunLoop
cycle: `(navigation)` (a navigation of the host such as Back), `(priority task)` (another call
of the host or a compositor's answer), `(task)` (#639). The steps of a nested event loop inside a
step (a dialog, a frame's script paused for the user) are steps of their own and not part of its
time: the line names them apart, `, N ms in a nested event loop` (#648). Work runs in the order
it was queued (patch 0184, #652): a RunLoop cycle runs the functions that wait at its start before
the timers due then, a function carries the time it was dispatched (the next step of delivering a
message, dispatched by a function, that function's), and a task of the page's event loop the time
it was queued (or that of the function that delivers it), by which WebCore's timer heap orders the
event loop against the other timers. So a timer that came due during a long task runs after the
messages of the window, of ports and of workers that were posted before its deadline, like in
Chrome. A view without a rendering update for two stall checks (2 s
apart, `WebView.cpp`) logs where it and its compositor stand (`stallState`), with the
compositor's phase and how long it lasts, since the scene started if it never ran (#402). Paint holding like Chrome and Safari (`WebView::holdPaintForNewPage`, #568): from the commit of a
new page (not after the initial empty document, not for a page from the back/forward cache) the
view keeps showing the page left. Rendering updates run as usual (layout, `requestAnimationFrame`),
but with layers nothing goes to the compositor (`LayerTreeHostWasm::flush`), which keeps
compositing the old committed layers, and without layers nothing is painted into the buffer. The
hold ends at the new page's first visually non-empty layout, at the end of its load (finished,
failed or stopped) or after 4 s, Chrome's limit for a new page that has not painted. Pinch zoom scales the shown tiles on the compositor and commits once at the end
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
(patch 0107, #488). An AVIF animation keeps only the decoded frame asked last in its decoder, a
frame is decoded alone (libavif seeks from the key frame), and the image itself keeps its frames
like any animation: all while they stay under WebKit's 30 MB cutoff, else the one shown (patch
0141, #561).
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
holds the text before the caret like a native field: whenever the caret moved otherwise (a key, a
click, a new field) the page's text before it in its paragraph (the engine's `caret` event, at most
100 characters, nothing of a password), then what the input method enters there. Every change of
it reaches the page as Backspaces and inserted text, so an Android keyboard's Backspace and
suggestions, which edit that text, work (#411), also on text that was there before. The field
carries the page field's `autocapitalize`, `autocorrect` and `spellcheck` as the engine resolves
them in `text-input` (the HTML spec's used hints with the form's as fallback, sentences and on
without one, none and off in URL, email and password fields), so keyboards start a sentence or a
name with a capital and offer suggestions like in a native field. iOS decides the capital only at
a focus and after text its keyboard entered itself: there the core focuses the field again
through a second one when the hints or that text changed after a tap or since typing, and a
character of the keyboard enters the field as well as the page (the field's input then finds no
change, #598). In Chrome
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
host gets no `take-focus` (#423). An arrow that reaches a date, time or color field or a select
opens its picker like Safari's keyboard (`bl_show_focused_picker` after the Tab), where the
keyboard closes (#617). On the
engine thread the host's calls run in their order before the engine's own waiting work, and
input (like the compositor's answers, #359) is taken in between two of its tasks and before
WebCore's timers (#365), makes WTF's
RunLoop return between two of its functions (patch 0072, #347) and WebCore's loops of deferred
and async scripts and of the page's event loop return after one item (patch 0074, #351). The
load and error events of images (WebKit's shared `EventSender`, which dispatched every waiting
one in one task) go out in passes of at most 16 ms like WebCore's timers, ending early when input
waits, and a document's load event waits for those of its images like in Blink instead of
dispatching the rest at once before it (patch 0159, #614): carousels such as Swiper lay the page
out in each image's load listener. Hidden
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
Digits typed into a part of a date or time field move on to the next part once the part is full
or no further digit fits (a month of 03 or 4, an hour of 9 on a 12 hour clock), like Chrome, so
03152025 types a whole date; the year takes up to 6 digits like Chrome's and moves on only at a
separator or an arrow key (patch 0143, #570). An empty part shows `mm`, `dd`, `yyyy` or dashes in
grey like Chrome and Firefox, not a part of the current date or time (patch 0144, #571). Like in
Chrome a part is only as wide as its text (with a value: its widest value, so it keeps its width
while the user types), and the field's edit element keeps the room for every part's widest value
or placeholder, so `11/20/2026` and `mm/dd/yyyy` show without gaps and the field keeps its width
when it gets a value (patch 0156, #603).
A `<select>` whose background or border the page sets loses its native look like in Chrome
(WebKit's `RenderTheme::adjustStyle` turns it into a `menulist-button`): CSS paints its background,
border and focus outline, and the Adwaita theme adds only the arrow inside the border in the
select's text color; before, it drew its light native button over the page's background, so the
light text of a dark site sat on a white box (patch 0157, #606). A select without them keeps
the native Adwaita button.
Form controls without author styles take the room they take in Chrome (patch 0161): the font
of `-webkit-small-control`, which `html.css` gives inputs, selects and buttons, is 13.333px
(16px less 2pt, `SystemFontDatabaseWasm.cpp`) like in Chrome and Firefox, a select keeps 1 px
above and below its text instead of Adwaita's 5, buttons 1 px (`themeAdwaita.css` for the port),
checkboxes and radios are 13 px with Chrome's margins. With the same font (Noto Sans) a text
field, button and select are as tall as in Chrome (24, 24 and 22 px). The Adwaita theme draws the
borders of text fields, buttons, selects, checkboxes and radios in Chrome's #767676 (dark
#858585, `Adwaita.h`): Adwaita's black at alpha 50 came out as #cdcdcd on white, 1.6:1, below
WCAG's 3:1 for non-text contrast.
Words end where they end in Chrome on Linux (#572). The engine's ICU data has Chromium's word
break rules: `tools/icu-word-rules.cpp`, built with the sysroot's ICU and run in node during the
engine build, takes the rules ICU stores in its `word.brk`, makes a full stop between letters
and a colon separate words ("example.com", "e.g.", "foo:bar"; "3.14" stays one) and compiles
them again; `tools/icu-data.mjs` puts the result in place of `brkitr/word.brk`. So a double
click, `Intl.Segmenter` and `text-transform: capitalize` see the same words as in Chrome. Moving and deleting by word (Ctrl+Arrow, Ctrl+Backspace, Ctrl+Delete,
`Selection.modify`) stop like Blink's `position_units_word.cc` (patch 0145,
`findPreviousWordPosition` and `findNextWordPosition` in WebCore's `TextBoundaries.cpp`):
punctuation and symbols end a word and a run of them is one stop, so one Ctrl+Backspace on
"hello world, " leaves "hello world". Ctrl+Left and Ctrl+Right go in the logical order of the
block's direction like Chrome, not visually through the runs of bidi text.
On a mobile device (`device.mobile`) the overlay scrollbars of the page and of scrolling boxes
only show the position, like in mobile Chrome and Safari: they take no hit tests, so taps,
touches and `elementFromPoint` reach the content under their 21 px. On a desktop, also one with
a touch screen, they take the press and drag (patch 0082, #413).
A long press selects the word under the finger at once and opens the context menu when the
finger lifts (#353), like Chrome's `HandleGestureLongPress` (`selectForLongPress` in
`WebView.cpp`): the hit goes into the text of a text field (UA shadow content) and into frames,
the text of a button, a date field or media controls selects nothing (as for a mouse press), the
pressed frame gets the focus, an editable element first gets the caret there, which focuses it,
and white space or an empty field keeps only that caret (#607).
The selection of a long press gets two handles like Chrome and Safari on phones (#625;
`TouchSelection.cpp`, `selection-handles.ts`). WebKit draws none itself (on iOS they come from
its UI process), so the engine sends the caret lines at both ends of that selection in view
coordinates (event `touch-selection`, after every rendering update that moved them, also by a
scroll, with `visible` false where a scrolling box or frame clips one) and the core lays two
drops over the canvas at their bottoms. Dragging one sends the point at the middle of its line
(`bl_selection_handle`); the engine moves that end there like WebKit's text interaction on iOS
without flipping (`rangeForPointInRootViewCoordinates`): the hit test of a mouse drag, within the
editable element of an editable selection, never past the other end, so one character stays.
On release it sends the menu of the selection, like Chrome's menu after a handle drag, without a
`contextmenu` event for the page. The menus of a long press and of a released handle carry
`selectionBounds`, the selection with its handles as the core shows them, and `showContextMenu`
of `@browser-lite/ui` opens such a menu above it, else below it, so the handles stay reachable
like under Chrome's menu above a selection. Any other change of the selection (a tap, typing, script,
another frame's focus) ends the handles; Select all keeps them.
The menu key and Shift+F10 open the context menu like Chrome on Linux (#621): a keydown of one of
them that the page did not handle (`WebView::contextMenuForKey`, like WebKit2's
`contextMenuForKeyEvent`) sends the page a `contextmenu` event through WebCore's
`sendContextMenuEventForKey`, in the focused frame, at the lower left corner of the focused
element, at the end of the selection, or without either at the visible corner of the view (patch
0162; WebKit took the document's corner, above the view on a scrolled page), and the menu opens
at that point unless the page cancelled the event. Firefox on Linux sends no keydown for these
keys but a `contextmenu` event of the focused element, the core's input field: the core cancels
it and sends the page the menu key instead (`keyboard.ts`), and after a menu key the page got
already (Firefox on Windows sends the event after the key) it only cancels it.
Text fields are spell checked like Chrome on Linux (#624; `Spelling.cpp`, `SpellingMenu.cpp`):
Hunspell (`deps/recipes/hunspell.sh`) with the dictionary of the first of the pages' languages,
like Chrome's default of the browser language, an exact match or one of the same language (en-GB
takes en_US), none for other languages (only en_US of SCOWL ships for now,
`deps/recipes/dictionaries.sh`). The dictionary loads on a thread of its own the first time a
field needs it (about 550 KB from `lazy/dictionaries`, the first underline about 0.5 s after the
first focus locally); a raw `pthread_create` starts that thread, since `WTF::Thread::create`
waits until a web worker runs it. The port has no unified text checking, so WebCore checks typed
words and the word left by the caret through `checkSpellingOfString`; whole texts (pasted text,
and like Chrome's cold mode the text a field already has once it gets the focus) go through
WebCore's asynchronous `SpellChecker`, which the engine answers at once, in pieces of about 4000
characters ending at white space, one per task (5 to 13 ms each), so the longest stall of the
engine thread after the focus of a field with 100 KB of text is about 50 ms instead of 260 ms. Words count as correct while the dictionary loads; its
arrival checks the focused field. Words without letters or with digits, words with letters of
another script than the language's (Greek in English text) and words over 64 characters are not
checked (Chrome's `SpellCheckWord` and `SpellcheckCharAttribute`), password fields not at all, and the
underline stays while the caret is in a word like in Chrome (`shouldEraseMarkersAfterChangeSelection`).
A right click on an underlined word selects it before the page's `contextmenu` event like Blink;
the event `context-menu` carries `spelling` (the selected or caret word, if misspelled, and at most
3 corrections) and `bl_spelling_action` replaces it (`insertReplacementText`) or adds it to the
dictionary, kept in `/data/spelling/custom-dictionary.txt` for all views. The preference
`spellcheck` (flag 16 of `bl_set_preferences`) turns it off and takes the underlines away.
Two fingers zoom the view (`touch-pinch.ts`) once the page answered both touchstarts without
`preventDefault` and touch-action allows it; the movement until then is kept and the zoom catches
up with it, also after the fingers lifted, so a pinch while the page keeps the engine thread busy
is not lost, like Chrome replays the queued touch moves (#505).
Only a finger that goes down is hit tested (#649): its touch events go to its touchstart target and
its pointer to its pointerdown target, which captures it implicitly like in Chrome (patch 0180
processes the pending capture before the target is picked), so the moves, release and cancel of a
finger bring no style and layout of a loading page forward. The press's `touch-action` and the
check for a paused frame use the same update as its touchstart.
Tab moves the focus to links too, like in Chrome and Firefox (`ChromeClient::keyboardUIMode`, #372);
past the last element it goes back to the host (`take-focus`), and `View.focusFirstElement`
enters the page from outside at the first or last element of the main frame, whatever it had
focused before, like Chrome's `SetInitialFocus` (#593).
Space, PageDown and PageUp, of the page and of scrolling boxes, step by 87.5 % of the view like
Chrome (`kMinFractionToStepWhenPaging`, truncated), not Safari's 80 %: a 706 px view pages by
617 px (patch 0151, `Scrollbar::pageStep`, #588). WebKit still leaves out fixed headers and
footers that span the view.
Ctrl + wheel first reaches the page (#167), and so do keys: a keydown the page does not handle
(no `preventDefault`, editing command or default action, `EventHandler::keyEvent` false) comes
back as `unhandled-key`, where the demo runs its shortcuts like Chrome; only the ones that leave or
switch the tab skip the page (#436). A key the demo has a shortcut for never gets the host
browser's own action (F5 and Ctrl+F5 would reload the demo, #580). The engine answers every keydown (`key-result`), and like
Chrome's input router the core holds later keyboard input until it answered a keydown that may be
a shortcut, one with Ctrl, Alt or Meta or one that types no text (`key-queue.ts`): what was typed
right after Ctrl+L goes to the address bar the shortcut focused, not to the busy page (#507).
Typing does not wait, so the keys typed while the engine was busy reach it at once (#524). Escape is Stop there, after the page and the demo's own
fields (#437). While a select list or a menu of `@browser-lite/ui` is open it takes every keydown in
the capture phase of the window, before the page and the demo, and the menus work like Chrome's:
arrows that wrap, Home, End, Enter or Space and a letter (#610). Paste, drag and drop and uploads write files into the engine
(#125, #126, #181). A drag of the page sends its data to the host (`page-drag-start`); over an
element of the embedding page (the view canvas has the pointer captured) the core sends that
element untrusted drag events with the data and the page a point outside the view, and a drop
there ends the page's drag with the drop effect (`bl_drag` phase 3, `drag-out.ts`, #534). Copy and cut and the page's `navigator.clipboard.writeText()` and `write()`
put text and HTML on the engine's clipboard, which the host gets as the event `clipboard`
(handler `clipboardWrite`; the async Clipboard API through `Pasteboard::writeCustomData`,
patch 0100, #469). A page's `navigator.clipboard.read()` and `readText()` in a user activation ask
the embedder asynchronously (patch 0150, `EditorClient::requestClipboardRead`): frames need the
permissions policy `clipboard-read` (default `'self'` like Chrome), the top origin the permission
`clipboard-read` (event `permission`), then the event `clipboard-read` gets the host clipboard
through the handler `clipboardRead` (default `navigator.clipboard.read()` of the host, a PNG as a
file like a paste) and `bl_clipboard_read_answer` puts it on the engine clipboard before WebCore
reads it (`engine/src/HostClipboard.cpp`, #587). Copy image of the context menu (`bl_copy_image`) hit tests the menu's point
again like Chrome's `CopyImageAt` and encodes the image there at full size, turned by its EXIF
orientation, as PNG with Skia (`onEngineCopyImage`); the core hands it to `clipboardWrite` as a
promise the click already wrote, as Safari requires (#511). Paste of the menu reads text and
HTML of the host clipboard (`readHostClipboard` of `@browser-lite/ui`) and hands both to
`view.paste` (`bl_set_clipboard`), Paste as plain text only the text; Undo and Redo run on the
undo stack of the view's `EditorClient`, whose state comes with `context-menu` (`canUndo`,
`canRedo`, #562).

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
A download is named like in Chrome (`Download::announce`, #601): the `download` attribute, else
the `Content-Disposition` file name (patch 0155: RFC 6266 with quoted strings and parameter names
in any case, `filename*` of RFC 8187 before `filename`, which may be raw UTF-8, RFC 2047 encoded
words or percent-encoded UTF-8), else the last path segment of the address, percent-decoded when
that gives UTF-8; path separators and control characters become `_`.
The engine hands the bytes of a download to the host as they arrive (`sendDownloadData`). With
`Download.save()` the core streams them into the host browser's downloads (#577): the page posts
them to `download-sw.js`, which answers the navigation of a hidden frame to `bl-download/...` with
an attachment whose body is that stream, so the host writes the file to disk while it arrives and
the page holds no bytes; a cancel in the host's download list cancels the download in the engine.
Without the worker the bytes collect in memory and become a Blob at the end.
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
redirects, CORS and CSP for pings); its responses carry curl's load timing up to the headers like
`NetworkDataTaskCurl`, which `performance.timing` reads, converted from the time origin like the
timeline's entries (patch 0178), and an https load on an open connection has `fetchStart` as its
`secureConnectionStart` (patch 0177, #644). curl keeps 64 connections, 6 per host (#176). A new HTTP/2
connection carries only the request that opened it until the server's SETTINGS announce how many
streams it allows; the waiting requests then take what the limit leaves, the rest open the next
connection (curl patch `deps/patches/curl/0003`, #479). curl decodes gzip, deflate, br and zstd;
like in Chromium a response whose Content-Encoding also names another coding (`UTF-8`, `foo`)
keeps its body as it is instead of failing (curl patch `deps/patches/curl/0004`, #586). The HTTP cache
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
memory cache stays shared by all views of the engine. A font request uses the font preload of
its URL even when the response varies by `Origin` (patch 0186, #660): WebKit loads fonts without
CORS, so a `crossorigin` preload sent an `Origin` header the font request lacks, and both the
memory cache and the HTTP cache took that for another response. HTTP authentication (#257, `HttpAuth.cpp`):
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
(notification badges, single page apps) and when a page comes back from the back/forward cache
(its load need not end again, #615); without one, `/favicon.ico` once the page has loaded. It
goes to the host (`icon`) once per document and icon address; the view keeps its last 4 icons, so
a page with the same icon address, or one that switches between a few (an unread badge), gets it
without a new request, and an icon that arrives after its page was left or its link changed is
dropped (#389, #520). The demo remembers the icon of each page like Chrome's favicon database,
for its history and suggestions, the tabs that have not loaded yet (#595) and a tab's new
document until the engine reports its icon (#615).

`navigator.onLine` and the `online` and `offline` events follow what the core reports
(`bl_set_online`: the host's `navigator.onLine` and `transport.connected`, #158). The engine's
`NetworkStateNotifier` (`platform/wasm/NetworkStateNotifierWasm.cpp`, patch 0008) takes the state
without an event when its first listener comes, so only a real change of the host fires the events,
never a read of `navigator.onLine` (#653).

## Storage

The engine uses WasmFS. `/data` is the OPFS directory `<namespace>` of the host origin
(`engine/src/Storage.cpp`, `engine/js/wasmfs-opfs.js`), so data survives reloads. Only one
browser per namespace owns it (Web Lock `<namespace>-data`); another tab runs with `/data` in
memory and gets the `storage-locked` warning. With `storage.persistent: false`, or without OPFS
(node tests), `/data` is in memory.

| Under `/data` | Owner |
|---|---|
| `cookies.db`, `localstorage/`, `indexeddb/` | WebCore and `WebKitLegacy/Storage` through the MemoryVFS (#67, #180) |
| `cachestorage/` | Cache API of the pages and workers (#105, #155, #567) |
| `serviceworkers/` | Service worker registrations (#105) |
| `opfs/<origin>/`, `opfs-swap/` | OPFS of the pages (#95, #166) |
| `tmp/` (incl. `tmp/uploads/<view>/`) | Atomic replacement and uploads, cleared at start (#142, #181) |

Cookies live in curl's `CookieJarDB` (SQLite). A public suffix is no cookie domain, except for the
host that is itself one (`github.io`, `httpbin.org`): like Chrome and Firefox (RFC 6265 5.3) its
cookies without a Domain attribute, or with one naming exactly that host, are kept host-only
(patch 0129, #533); before, every cookie of such a host was dropped.

localStorage and sessionStorage hold 5 MiB of UTF-16 code units of keys and values per origin,
whatever the width of the characters, like Chrome and Firefox (patch 0140, #556); WebKit counted
bytes, so text outside Latin-1 had half the room.

Read-only files outside `/data`: `engine.data` (Noto Sans regular and bold, fontconfig with its
cache, CA list) in memory, and `/lazy`, files of `lazy/` next to the engine that load on first
use: `/lazy/icu`, the ICU data beyond the core linked into `engine.wasm` (`engine/icu-core.txt`,
#228), `/lazy/fonts`, Noto Serif, Mono, the italics, more scripts, symbols, Chinese,
Japanese, Korean and emoji (#229), and `/lazy/dictionaries`, the spell checker's (#624). `LazyFiles.cpp` lists them from an index (sizes, so `stat`
needs no request) and fetches a file whole with a synchronous request on its first read, so only
pages that need a locale, collation, dictionary, charset converter or font download it.
fontconfig's cache in `engine.data` already describes every font of `/lazy/fonts`, so finding a
font for a character reads no font file; a family is matched with the bindings fontconfig stores
for its names instead of a match per name (patch 0176, #645); Chinese, Japanese and Korean are cut into the slices of
Google Fonts (most frequent characters first, about 30 KB each with Brotli), emoji into the
Unicode emoji groups and the symbol fonts into Unicode blocks. Files usually needed together are
a group (a CJK font's most frequent slices, the data of an ICU locale): the first read fetches the
others in parallel. Once the engine runs it fetches the files of `engine/lazy-prefetch.txt` and
the ICU groups of the user's languages in the background (#240). Once the first page loaded, ICU's
collation data (`coll/ucadata.icu`, `coll/root.res` and the user's languages, about 0.96 MB) loads
into memory in the background (`engine/src/CollationData.cpp`, `preloadLazyFiles`), so the first
`Intl.Collator` or `localeCompare` waits for no request (#659). The first read the layout waits
for scans the rendered text outside Latin-1 and fetches the fonts and dictionaries it needs side
by side (#252, #485);
fonts only reached as a fallback for characters (scripts, CJK, emoji) hold up the engine thread at
most 300 ms, the text is laid out again once they are there (#255), only the elements with text
outside the fonts of `engine.data` (#401). Text drawn or measured into a 2D canvas has no second
layout, the page reads its widths and pixels back at once: it waits for these fonts like for
local ones (patch 0171, `engine/src/CanvasTextFonts.cpp`, #637) and looks up again the
fallbacks a layout remembered as missing. The fonts of a cascade keep every fallback font their
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
it does itself (the media feature, the containers of its MSE parsers, no streaming manifest as a
file: the host `<video>` gets one resource through the service worker and the segments an HLS
playlist or DASH manifest names would bypass the engine's network, so pages stream them through
MSE like on Firefox, #549; one set as `src` anyway, known from `.m3u8` or from the response's
`Content-Type` in `MediaFetch`, fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` before the host sees
it, #581); for the codecs it asks
the host: `canPlayType` and `isTypeSupported` synchronously (common types answered ahead, #137),
`navigator.mediaCapabilities.decodingInfo` of pages and workers asynchronously with the host's
own `decodingInfo` on its main thread, so `supported`, `smooth` and `powerEfficient` are the
host's (`MediaCapabilitiesWasm.cpp`, #503). With compositing the host shows its own `<video>`
(#232): the video gets a composited layer whose contents is a hole punch buffer (patch 0047) once
the host's `<video>` has a frame (before, it draws nothing and what lies under it shows, like in
Chrome, #573), the compositor clears that rect in the framebuffer (its WebGL context has alpha) and
`VideoOverlay.cpp` sends the transform of every hole after a shown whole frame ("place"), so a
damage tile never shows a hole and keeps off the holes of the last whole frame (#550); the core puts
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
frames keep the alpha of transparent VP8, VP9 and HEVC videos (RGBA, not premultiplied, #442).
The host reads a copied frame off its main thread: it takes a `VideoFrame` of its `<video>` and a
module worker (`frame-reader-worker.ts`) draws it at the size on screen and reads the pixels, the
main thread only copies them into engine memory (`frame-reader.ts`, #608). Sound
comes straight from the host element. A hidden page pauses media that never played with sound like
Chrome: video without an audio track (#170) and media muted ever since it started (#555, Chrome's
"was always muted"); media that played unmuted keeps playing. The host reports whether its element
has an audio track: `audioTracks` (Safari), `mozHasAudio` (Firefox),
decoded audio bytes (Chrome, #386). Muted or silent `autoplay` video plays only while it is in
the view (WebCore's `InvisibleAutoplayNotPermitted`, like Chrome and Safari on iOS): one below the
fold waits, one scrolled out pauses and plays on when back; `play()` from a script and a start
during user activation lift the rule for that element (#399) and end its wait, so a hidden page
still pauses it (#555). Sound needs a user activation like Chrome's autoplay policy (#578): media
that is not muted and Web Audio start only once the user activated the page, which stays so for
that document (WebCore's `RequiresUserGestureForAudioPlayback` and
`MediaUserGestureInheritsFromDocument`, patch 0147); without it `play()` rejects with
`NotAllowedError`, `autoplay` waits and an `AudioContext` stays suspended. The engine numbers its play and pause commands for the host `<video>` and takes the host's `paused` only from a report that names the last of them (#590), so a report still on its way does not undo a newer command. WebCodecs, MediaStream, MediaRecorder, WebRTC and Picture-in-Picture use the host's
implementations (#107, #113, #114, #117 to #119); the corresponding services must be enabled.
The pages see only the cameras and microphones the host has (#647): the capture service sends
their numbers (`bl_set_capture_devices`, at start, on `devicechange` and after a device opened;
no ids or names), the engine lists that many like Safari (before the origin's permission at most
one of a kind without id and name, no `audiooutput`) and rejects `getUserMedia` for a kind the
host lacks with `NotFoundError` before any prompt. The host device opens before the page's
`getUserMedia` or `getDisplayMedia` resolves (`capture-open`, answered by `bl_capture_opened`
from the source's `whenReady`), so a device the host cannot open rejects the request
(`NotReadableError`, `NotAllowedError`, `NotFoundError`) instead of giving a track that ends.
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
`webkitEnterFullscreen()` works (#476). Patch 0135 gives them the keys and the double click of
Chrome's controls: on the focused element Space and Enter play or pause, the arrows left and right
step by a hundredth of the duration, Home and End seek to the ends, up and down change the volume,
and a double click on the video toggles fullscreen (#552). Patch 0142 keeps the focus in a
layout of the controls: a control already in its place stays in the tree, a moved control gets its
focus back (the start button is the play button, which moves into the bar when playback starts),
and the media element gets it when the control is gone; a control shows its focus only after the
keyboard focused it (`:focus-visible`), not after a click (#569). On a fullscreen narrower than the
468 px fullscreen bar with 16 px margins (a phone held upright) patch 0136 shows the inline
controls instead, which drop buttons by width and have the exit button top left; turned to
landscape the fullscreen bar comes back (#553).
The context menu of a `<video>` or `<audio>` has Chrome's media items (#622):
`engine/src/media/MediaMenu.cpp` adds `media` to the event `context-menu` for the media element of
the menu's hit test, which takes the controls as their element (address, `canSave` from
`MediaPlayerPrivateWasm::canSaveMediaData`: a file at an http(s) address, not MSE or a stream;
loop and controls with Chrome's rules for switching them; the picture-in-picture state), and
`bl_media_action` hit tests the point again like Chrome's `MediaPlayerActionAt` and sets `loop` or
`controls` in a user gesture. Picture in picture lives in the polyfill (`WebRTCPolyfill.cpp`), so
the polyfill leaves a function for the menu on its bridge (`pictureInPictureMenu`; the engine
keeps each window's bridge under a private name, `pageBridge`), so the start of a window calls
nothing more: it answers the state (the window's element, metadata,
`disablepictureinpicture`, a host player or a live track) and enters or leaves the window with its
own `requestPictureInPicture`, which a page cannot replace, so the page's events and
`pictureInPictureElement` stay right. The UI (`defaultMenuItems`) renders Loop, Show controls and
Picture in picture as checkable items and opens, saves and copies the address like an image's.

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
shared memory or JSPI (#153). A command reaches the host side through an import of its own
(`bl_wasm_dispatch`), which reads and writes the slots with the memory's views taken once:
with threads and a growing memory every `HEAP` access of Emscripten's glue looks at the
memory's buffer, 4 % of the engine thread while hCaptcha's `hsw.js` ran (#637). Page workers run from the host event loop so finalizers fire (#183); a worker thread that waits
for a lock runs the calls queued for it, so a pump of its run loop that arrives then only asks
for another one after the running pump (patch 0170, #635).
Like the engine's polyfills (`callEngineFunction`), the API is evaluated with the source URL
`browser-lite`, whose functions print as `[native code]` like JSC's builtins (patch 0169, #634).

## Garbage collection

JSC's GC is conservative and scans the stack, but WASM locals are invisible to it. Instead of
spilling all pointers (#17, 14x slower) the engine runs the GC only on an empty stack: every
engine task runs under `DeferGC`, and explicit requests wait for the outermost one (patch 0012,
#36). During long scripts the heap sets a VM trap that the interpreter serves at instruction
boundaries where all values are in memory (#60, #72, `engine.safepointGC`), also inside the VM
entries of the JIT's generic calls (patch 0090, [jit.md](jit.md)) and of a bound function's call
of its JS target (patch 0115, #516: React's scheduler runs a whole render through one). Trap
checks of C++ code leave the CodeBlocks alone while the heap waits for such a safepoint (patch
0114: JSC walked all of them for breakpoints that only signal based traps install) and leave its
trap set for the next one (patch 0149); the embedder runs its own work there first (#585). The heap
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
footprint grew by 32 MB. Above 192 MB (`BL_MEMORY_RELEASE_MB`; the core sets 512 MB on hosts with
8 GB of memory or more, where each release blocked a heavy page's load 130 to 470 ms and freed
little of what it still needed, #633) it calls `WebCore::releaseMemory` (#61, #64), which keeps
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
document kept that whole page for good (`tests/core/abort-signal-gc-test.mjs`). A release is a
full GC that blocks the engine thread (0.3 to 0.6 s on a phone), so one that falls due within 3 s
of input to a visible view or of a navigation of the host waits until no input came for 3 s (at
most 10 s, not when memory is short): it no longer lands in the page's answer to a tap or Back
(#651). Once the malloc area ends above 384 MB it grows the memory ahead so that 128 MB stay free
above it; when that fails, the current size is the limit. Only where that limit can exist: a
memory that reserved its full 4 GB in a 64 bit address space (`engine/js/engine-memory.js` probes
a 3 GB resizable `ArrayBuffer`) never fails a growth before the host runs out, so there
`BL_MEMORY_RESERVE=0` and the memory grows with malloc, at most 16 MB beyond what it asked for
(`MEMORY_GROWTH_GEOMETRIC_CAP`, #651). The reserve and Emscripten's growth by 20 % (up to 96 MB)
made a heavy page's memory about 150 MB bigger than its malloc area, and WASM memory never
shrinks. JS heap blocks are 16 KB on WASM like on other systems (patch 0183) and threads that run
no JS get stacks of 1 MB instead of 4 MB (patch 0182).
From then on, or above the budget of 3 GB, it reports `memory-pressure` `{footprint, limit,
level}` at every growth, and the host discards background views (#128, #171, #216). On iPhone
and iPad a growth never fails, iOS ends the whole web content process instead, so the core sets
the 3 GB of `BL_MEMORY_PRESSURE_MB` to 512 MB there (#358). Memory is short, level `critical`,
with less than 128 MB left below the limit, or above the budget when less than that is free
inside the malloc area after a release that kept the code and the page left last and still after
a second release that drops them too (#497, #618). Otherwise the level above the budget is
`moderate`: the footprint never shrinks, and after one heavy page most of it is free again.

Above 2 GB a wasm32 pointer is a negative `i32` in JS. Emscripten makes the pointers of its own
library functions, of `EM_ASM` arguments and of `malloc` unsigned and rewrites direct `HEAP*[p]`,
`subarray` and `set` accesses, but not the parameters of `EM_JS` functions, and `slice(p, ...)`
with a negative `p` counts from the end of the memory. So every `EM_JS` function starts with
`p >>>= 0;` for each of its pointer parameters (`tests/contract/pointers-test.mjs`), and glue that
computes an index from a pointer shifts with `>>>` (#465, `tests/core/heap-above-2gib-test.mjs`).

## JavaScript

JSC runs the C loop interpreter (`ENABLE_JIT=OFF`). Patches turn on the interpreter's call
caches on 32 bit (#62), add caches for `instanceof` and missing properties (#143; not on objects
whose structure does not list all own properties, such as module namespaces, #431), keep a
second structure in the cache of a property read (`get_by_id`, `get_length`) and read a
string's `length` without the slow path (patch 0179, #648) and leave mini
mode off (#122). Scripts are compiled to bytecode on every visit: a persistent bytecode cache
brought no measurable gain and was removed (#215). A JIT to WebAssembly compiles hot functions
(on by default, [jit.md](jit.md)).
Regular expressions have no JIT here: the Yarr interpreter measures each pattern and hands those
that cost much per character of their input to a RegExp of the host's worker (patch 0073,
`HostRegExp.cpp`, `BL_HOST_REGEXP`, #348). The measured cost belongs to the pattern's source and
flags, so a RegExp compiled again after a GC or a memory release keeps the decision (#362). The
first call decides; a pattern in the host is measured in the interpreter again only at call 32,
64, 128 and so on, and not while its calls in the host are heavy (#631). The measurements read
WTF's `MonotonicTime`, which here is the host's `performance.now()` (patch 0166; before it was
`Date.now()` in whole milliseconds).
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
deeper one are probed too (#500). Each thread trusts that frame once a test showed it fails where
a recursion of known frame size fails: a WASM recursion counts how deep the stack goes, a second
one stops short of the end and calls the frame there, about 1 ms per thread; the page main thread
makes the probes first, so V8 compiles the frame there once for all threads (#658). A one-character `replace` on a
deep rope string (a string built by appending) probes too and then replaces in the resolved string
(#368). The parser and the bytecode generator take the else branches of a conditional chain
(`a ? b : c ? d : ...`, webpack's map of chunk names) in a loop, and the parser gives up at once
when out of stack instead of retrying other readings of a deep literal at every level (patch
0109, #499). Recursion through C++ (a getter calling a getter, proxies, `toString`, a `sort`
comparator) takes about 1.1 KB of machine stack per level and so stops after 300 to 550 levels
in Chromium, where Chromium's own pages reach thousands (open, [status](status.md)).
