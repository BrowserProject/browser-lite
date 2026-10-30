# Status (2026-10-27)

Where the project stands, what was measured, what is open. Numbers like #142 refer to
[decisions.md](decisions.md); real sites are in [compatibility.md](compatibility.md).

## What works

- **Structure**: reusable packages (`@browser-lite/core`, `transport-wisp`, `ui`, `profile`,
  `server`), the engine contract `engine/abi.json` with contract tests, and the demo `apps/demo`
  on the public APIs only (#198 to #206), plus tested embedding templates in
  [examples/](../examples/README.md) (own route, existing site with its own service worker and CSP).
- **Engine**: WebKit (WebCore + JavaScriptCore C loop) as WebAssembly, TLS inside, network through
  our own Wisp relay that connects only to public addresses and web ports (#159, #178, #201).
- **Browsing**: views with popups (opener, name, sandbox), history incl. back/forward cache,
  downloads, uploads, find, zoom, pinch zoom on the compositor (#150), print to PDF, view source,
  external schemes to the host after a click (#148), context menu data, link hover, fullscreen,
  HTTP authentication with Basic and Digest and a sign-in dialog like Chrome's (#257).
- **Input**: keyboard incl. dead keys and IME preview (#127), clipboard with HTML and files
  (#126), drag and drop (#125), touch, pointer lock, ctrl + wheel to the page first (#167).
- **Dialogs**: `alert`, `confirm`, `prompt` and `beforeunload` hold only their page like in
  Chrome; with an in-page dialog handler (a promise) the other views keep loading, running and
  rendering (#258).
- **Rendering**: GPU raster with Skia on WebGL 2, compositing and async scrolling on own threads,
  no frame without a visible change (damage tracking, #220), the first paint right after the first visible layout, before
  waiting scripts (#246), GPU blur and shadow, CSS Paint
  Worklet, WebGL 1 and 2, recovery after GPU loss.
- **Media**: `<video>`/`<audio>` (also `blob:`, `data:`), MSE, Web Audio, WebCodecs, camera,
  microphone, screen, MediaRecorder, WebRTC (opt-in), Picture-in-Picture, all through the host.
- **WebAssembly of pages** in the host engine, also memory64 and multiple memories (#152, #184).
- **Workers and storage**: service workers with soft update and navigation preload, Cache API,
  OPFS, IndexedDB with limit (#179), cookies and localStorage, all in an OPFS namespace (#142),
  HTTP cache in the host Cache API (#70), partitioned by site like Chrome (#213), with ranges
  (206, media pieces) like Chrome's sparse entries (#222).
- **Robustness**: watchdog for scripts (#146), crash and hang detection with in-page restart
  (#147, #172), hidden background views (#170), memory pressure near the memory limit found at
  runtime, also in 32 bit browsers with about 1 GB (#171, #216), error pages with the
  relay's reason and auto reload (#174, #175), dead relay detection (#177), fix of a WTF timer
  bug that aborted about 1 % of heavy page loads (#219), pages left behind no longer kept alive
  by old words on the C stack that the conservative GC scans (#296; soak test 0 of 15 local runs
  with pages that stay, before about 1 in 5).
- **Slow networks**: download progress at the start (#226), the relay connection opens while the
  engine downloads (#227), ICU data and fonts beyond the basics load on first use (#228, #229),
  the common ones and the user's languages in the background right after the start (#240),
  data saver (`Save-Data`, #230), the relay traffic spread over 3 WebSockets against packet loss
  (#235), the relay keeps only about two round trips of data on the way, so a small response no
  longer waits seconds behind large downloads (#245), `<link rel=preconnect>` opens the connection ahead (#247), the fonts and line break dictionaries a page's
  text needs load side by side (#252), the code that the start and common pages do not run loads after the start in chunks
  (#238), an address typed meanwhile opens once the engine runs (#239); a first visit at
  5 Mbit/s, 150 ms starts after 15 s instead of 32 s (`tests/bench/slow-start.mjs`); after an
  engine update Chrome loads deltas against the old engine, ready after 2.5 instead of 15 s
  (#244).
- **Weak devices**: render resolution limit for high pixel ratio screens, the demo renders at most
  2x by default (#231); video plays in the host's own `<video>` behind the view canvas (#232);
  after a browser restart the engine comes compiled from Chrome's code cache (#237); new threads get
  loaded web workers from a reserve that refills in the background, the engine thread no longer
  waits 60 to 180 ms for a worker to load (#242); a JPEG drawn at half its size or smaller
  decodes smaller, a 4000 x 3000 photo shown at 400 x 300 takes 0.7 instead of 46 MB of pixels
  (#270).
- **Fonts**: Noto for about 20 scripts, symbols, Chinese, Japanese, Korean and color emoji
  (COLRv1), loaded on demand in small slices (#229).
- **Profile on the server**: cookies, localStorage and small IndexedDBs plus app prefs, only the
  last device writes (#188 to #191, #197).
- **Demo on phones**: a phone layout below 640 px of width or 500 px of height like mobile
  Chrome (compact toolbar, tab overview, menu and panels as bottom sheets, touch targets of
  44 px, safe areas, sheets above the iOS keyboard), checked on emulated phones; Android hosts
  get an Android identity by default like iPhone and iPad hosts (#290).
- **Settings**: device emulation with Safari user agents, languages, time zone, color scheme,
  JavaScript, images, Global Privacy Control (#193 to #196).
- **Network identity**: the TLS ClientHello has Safari 26's JA4 (`t13d2013h2_a09f3c656075_7f0f34a4126d`)
  and HTTP/2 its Akamai fingerprint (`2:0;3:100;4:2097152;9:1|10420225|0|m,s,a,p`), request headers
  come in Safari's order with its values, compared with real Safari 26 on tls.peet.ws and a header
  logging server (#283). Bot managed sites (Amazon, Nike, Zalando, Ticketmaster, Best Buy, Lowe's,
  Costco, adidas, leboncoin, StockX, Indeed) load from the test machine; Home Depot (Akamai), Hermes
  and G2 (DataDome) block that IP also for Chromium, Walmart and Zillow (HUMAN) ask for press and
  hold after repeated automated visits, with the old and the new fingerprint alike.
- **Browsers and devices** (2026-10-28, real devices through BrowserStack): macOS Safari 18.4
  (incl. profile sync), iPhone 16 and iPad Air 13 on iOS 18 (Wikipedia mobile, YouTube, MP4 with
  sound after a tap, the on-screen keyboard with the field's input mode, 20min.ch with its consent
  dialog for two minutes), Samsung Galaxy S23 and Motorola Moto G71 Chrome, Windows 11 Firefox;
  muted autoplay video on iPhone, Galaxy S23 and macOS Safari, video with sound after a tap on
  iPhone (#295). Firefox runs every suite in CI (open failures below).
- **Extensions**: a plugin system for integrators ([extensions.md](extensions.md), #280 to
  #282): request handler chain, scripts (isolated worlds) and CSS in pages by match patterns,
  messages, storage, UI slots rendered by the demo; no extensions yet, and without one nothing of
  it runs.
- **Yardstick**: 257 of 280 checks like Chromium.
- **CI and deploy**: every push to `main` builds, tests and deploys the demo to the home server
  through a LAN runner without foreign actions (#160, #185).

## Measurements (local, first visit)

From `tests/compat/site-test.mjs`, time from the start of the UI, 3 runs each on 2026-10-16:

| Site | First layout | First paint | Loaded |
|---|---|---|---|
| YouTube | 2.5-3.1 s | 2.5-5.7 s | 5.1-6.7 s |
| GitHub | 3.1-4.3 s | 3.4-4.6 s | 2.8-3.3 s |
| weather.com | 2.3-2.8 s | 2.4-3.0 s | 5.2-6.4 s (content changes) |
| NZZ | 3.4 s | | 14-21 s |
| CNN | 3.1-3.8 s | 3.2-4.0 s | 21-26 s |
| Wikipedia (Schweiz) | 3.9-4.6 s | 4.1-4.8 s | 7.3-8.4 s |
| Twitch | 6.7 s | | 8-34 s (content changes) |
| 20min | 3.7-8.6 s | 3.8-8.9 s | 27-29 s |

Engine ready after about 2 s locally. Real sites vary a lot (ads, changing content): compare
performance with several runs and inclusive times from profiles, not only load time.

## Measurements (slow network)

`tests/bench/slow-start.mjs` (packaged demo behind a link of 150 ms, 5/1 Mbit, medians, this
machine), on 2026-10-26 before and after #226 to #229:

| | Before | After |
|---|---|---|
| First visit: engine files transferred | 20.3 MB | 14.1 MB |
| First visit: ready / first paint of a small page | 32.4 / 33.9 s | 22.6 / 23.5 s |
| Second visit: ready / first paint | 1.6 / 2.2 s | 1.6 / 2.0 s |

With 1 % packet loss (kernel netem between network namespaces) one TCP connection carries about
1.3 Mbit: the first visit was ready after 133 to 151 s (the server's congestion control stays as
it is, #234), and a page of 5 MB loaded 19.7 s after ready with 3 relay WebSockets instead of
33.7 s with one (#235; plain Chromium 9 to 14 s).

With the engine split (#238) the start needs 8.8 instead of 13.8 MB: ready after 15.2 s instead
of 23 s, a small page painted after 16.5 s instead of 24.1 s, Wikipedia after 21.2 s; sites
outside the profile wait for the chunks they need (Hacker News 20.5 to 22.4 s instead of 25.7 s,
elpais.com 18.4 instead of 24.6 s, python.org 27.9 instead of 27.0 s).

After a restart of Chromium (same profile, local, 2 cores) a small page painted after 2.2 s
instead of 2.9 s once the engine came from the code cache again (#237).

On 2026-10-27, same link: after an engine update the new engine came as deltas against the old
one, ready after 2.5 instead of 15 s (#244); a second visit was ready after 1.0 instead of 1.13 s
once the hashed app files were no longer revalidated (#243); behind 4 downloads of 3 MB a small
response of another origin came after 0.5 to 0.85 s instead of 17 to 20 s (native Chromium 0.5 to
1.1 s, #245); the first request to a preconnected origin took 0.16 instead of 0.44 s (#247).
Wikipedia on a first visit: ready 14.8 s, first paint 21.8 s, loaded 25.6 s. With a warm engine
Wikipedia (one `<video controls>`) painted 2.87 instead of 3.65 s after ready once the media
controls came after the first paint (#253), and restarted with Wikipedia as address 2.25
instead of 2.82 s once curl, the cookie database and our page extensions were set up ahead
(#254). bbc.com, whose language menu needs 13 fonts of other scripts, painted after 4.4 instead
of 5.7 s once those fonts no longer held up the text (#255).
A warm start (same profile, local) on 2 cores painted a small page after a median 1.70 instead
of 2.06 s once the compositor's WebGL context came during the start and the worker reserve waited
3 s (#249, #242); the demo, where the profile and the engine now load side by side (#248), after
about 2.0 instead of 3.2 s.

## Measurements (emulated devices)

From the performance work of #213 to #225 (CI and dedicated hosts, medians of 20 to 30 runs,
under SwiftShader, no real GPU). S is a fast device with 2 cores, C a cheap Chromebook with
2 cores at a third of the speed; sites came from Web Page Replay.

| | S | C | Chromium on C |
|---|---|---|---|
| Start, first after an update: ready / first layout of a small page (LAN) | 3.0 / 6.6 s | 6.8 / 15.4 s | |
| Start, again: ready / first layout (LAN) | 2.9 / 3.5 s | 6.7 / 8.2 s | |
| Start, first after an update, mobile network (80 ms, 20 Mbit) | | 11.6 / 18.9 s | |
| Video VP9 360p / 720p, frames per second (#217) | 9.7 / 4.5 | 2.4 / 1.8 | 25 to 30 |
| WebGL 1280x720, drawn every frame, frames per second (#221) | 9.6 | 2.6 | |
| Animation outside the view, CPU seconds per second (#220) | 0.025 | 0.026 | 0.012 |
| CNN second visit, data received against before #222 | 6 to 61 % | 42 to 55 % | |

A native WPE WebKit on one server core showed the first picture of Wikipedia and GitHub 4 to 21
times earlier than the engine on the device (#224); the engine stays in the device.

## Open: performance (by value)

1. Compiling on first call (weather.com about 11 s parser and bytecode), also on repeat visits:
   a persistent bytecode cache hit but brought no measurable gain (#215).
2. Interpreter time (15 to 21 % on JS-heavy sites): only a big rework (tail-call interpreter or a
   JIT to WASM) would help; small caches are done (#143).
3. Forced flex/grid layout from JS (20min about 6.5 s, #141): no cheap fix found.
4. GC 5 to 7 % on JS-heavy sites (#60, #122).
5. Video and animations: with compositing Chromium shows the video itself behind the view canvas
   (#232); videos with opacity, blend modes, filters or 3D transforms keep frames painted into the
   tiles of the view, locally under SwiftShader 1.8 to 9.7 video frames per second against 25 to
   30 in Chromium (#217). Frames without a visible change are skipped since #220 (an
   animation outside the view took all CPU of the device before, now 0.03 CPU seconds per second
   on C); where every frame changes, a frame costs as much as before, and compositing only the
   damage cost more under SwiftShader (CI perf 39644894451 and 39670991733, #220).

6. Images drawn small still decode at full size unless they are JPEGs or still WebPs (#270,
   #286): PNG, AVIF, GIF and animated WebP decoders ignore the subsampling level. A JPEG also
   decodes at full size for `img.decode()`, WebGL, `createImageBitmap`, `createPattern` and
   repeated CSS backgrounds, and keeps that frame for later small draws (like Safari).
7. Memory of the host tab: with a trivial page the renderer of Chromium holds about 480 MB
   (2026-10-27, local): the engine memory (256 MB reserved, about 90 MB touched), about 220 MB
   of malloc inside the renderer that does not change with the number of workers (each spare
   worker about 4 MB) and is most likely V8's data of the 44 MB `engine.wasm` and the chunks,
   34 MB of compiled code; after bbc.com/news 720 MB, after CNN 960 MB. Smaller only with a
   smaller module.
8. Split engine (#238): a site outside `engine/hot-functions.txt` nearly always needs deferred
   code on its first load and waits for those chunks while the others download too; one that
   needs many paints a little later than with one module (python.org 27.9 against 27.0 s). Renew
   the list with `tools/hot-functions.mjs` after WebKit updates and after patches that change
   WebKit code: identical functions folded by the linker can come out under another name (after
   patches 0061 and 0062 the start needed 25 chunks, `deferred-test.mjs` found it).
9. The relay transport runs on the host page's main thread, every packet of the engine passes it.
   With the main thread busy 80 ms of every 100 ms (2026-10-29, local, 60 small fetches in a row)
   the median of a fetch stayed at 2 to 3 ms, the 90th percentile went from 3 to 5 ms up to 82 ms
   and the mean from 2.2 to 11.8 ms: only packets that meet a long task wait for it. A transport in
   a worker pays off for hosts with long tasks of their own, not for the demo.

## Open: features

- `device` and `timeZone` apply only at `createBrowser` (the demo restarts the engine for all its
  settings); emulated mobile devices do not rotate.
- Pinch zoom: `visualViewport` events only at the end of the gesture; two fingers wait for the
  page's touchstart answer even without blocking listeners.
- Background views: `scheduler.yield()` and `postTask` are throttled like nested timers; video
  without an audio track pauses when hidden like Chrome (not after PiP, #170); discarding under
  memory pressure does not spare tabs with beforeunload listeners and input.
- Memory: a single page that needs more than the limit (about 1 GB in a 32 bit browser) or one
  allocation bigger than the 128 MB reserve can still crash the engine (#147, #216).
- beforeunload: the host tab asks on close once a view with a listener had input, even if its
  handler would not ask; listeners only in iframes do not ask on close.
- WebAssembly: shared memory (threads) and JSPI (#153; `validate()` says false, so pages take
  their variant without); cycles between page and module are freed only with the page or worker.
- CSS: `url(#...)` and SVG filters on the CPU; filtered layers with children, masks or video
  recompute every frame; `interpolate-size`; Paint Worklet scripts are classic (no
  `import`/`export`) and runtime errors reject differently than in Chromium.
- Graphics: WebGL frames through `readPixels` instead of a texture (a GPU path was slower under
  SwiftShader, #221), tiles painted on the CPU (Skia's GPU painting exists upstream, but
  `LayerTreeHostWasm.cpp` passes no GPU context; not measurable without a real GPU, #224), timer
  queries, queries and
  transform feedback across context switches, WebGPU. Views that lost the GPU while compositing
  stay without layers (new views get them again); a WebGL page that does not draw notices a loss
  only at its next draw.
- Media: EME (DRM), MSE in workers (#121), WebCodecs frames as textures, WebRTC traffic through
  the relay (TURN), insertable streams. A sent track's engine sink stays until `stop()` or until
  its source ends; MediaRecorder errors while fetching data do not reach the page as an event. A
  muted autoplay video briefly reports `pause` and `playing` again right after loading (Chrome
  does not).
- Service workers: Push, Background Sync, Background Fetch.
- Network: WebTransport, streams as request body, Storage Buckets,
  WebSocketStream without read backpressure (#120). Fingerprint (#283): no GREASE, OpenSSL's
  extension order and point formats (JA3 and peetprint differ from Safari's), Safari's header order
  only approximated for header sets not measured (cross-origin GET, beacons); the TCP/IP
  fingerprint is the relay's.
- Storage: localStorage reaches SQLite 1 s after a change and can miss the last change on close;
  with `/data` in memory (second tab) uploads sit in WASM memory. WebKit's memory cache is shared
  by all views of a running engine, only the HTTP cache is partitioned (#213).
- Measurement: layout shift and long animation frame entries, IdleDetector,
  `document.featurePolicy`.
- UI: drag and drop outside a drop target opens nothing (#125; Chrome loads the link or file in
  the same tab, deliberately not here because an accidental drop would replace the page).
- Devices and identity: passkeys (WebAuthn has no authenticator, #298), password credentials,
  Payment Request, Web MIDI/USB/HID/Serial, WebXR.
- Extensions: no blocking or observing of requests (an engine export for WebCore's content
  extensions or a URL filter), no accessibility tree (an engine export), scripts not in workers,
  in already open documents or in `about:blank` frames.
- Core API: no event for console messages without a view (service workers), no warning for
  skipped uploads (larger than 512 MB), no way to re-arm the watchdog after "wait".
- The test hooks `gpu()` are not gated by `BL_TEST_HOOKS` in the engine (only the host can call
  them).

## Open: tests and operations

- Firefox 155 (CI job reports without blocking): `compositing-test` CPU painting after a GPU
  loss without the compositor thread (only with `compositing=0`, an expert setting): the engine
  presents the right CPU frame at once (checked in the worker: the scratch canvas has the new
  color), but Firefox shows white until the context is back. Neither the source of the
  `ImageBitmap` (`transferToImageBitmap` of a 2D canvas, `createImageBitmap` of `ImageData`) nor
  the size handling changes that. With the compositor thread (the default) the screen shows the
  CPU frames after a loss; probably because there the worker that lost the WebGL context is not
  the one that presents. A workaround would be a new view canvas from the main thread after the loss; `compositing-test` skips this check in Firefox. Now and then in CI (auth, clipboard, background tests)
  an engine worker loaded for about 60 s and then failed: the core's service worker waited in
  `activate` for `clients.claim()`, which waits for the new worker, whose script request waits for
  the activation. Fixed (#301, locally 0 of 8 runs instead of 1 of 5); the engine still logs such
  a worker (`[workers] engine worker did not load after ... ms`). Closing or reloading a tab right after a
  change lost it in Firefox (#275, the engine cannot write while `pagehide` waits): commits now go
  to a commit log at once (#302), localStorage reaches SQLite 100 ms after a change (#303).
- WebKit (Playwright 1.63 in its Docker image, locally, #293), 2026-10-28: of the core suite 13
  tests pass, of the demo suite 6; the failures come from the image (no WebGL, OPFS,
  `MediaRecorder`, fake camera, grantable permissions, `DeviceOrientationEvent` constructor, routes
  of worker requests) or from frames of a view without the compositor while another view's dialog
  blocks the engine thread (WebKit shows a worker's canvas frame only at the end of its task).
- Firefox frees the documents a tab left only when memory runs short: a page with a 200 MB
  buffer loaded every 1.5 s in one tab grew its process to 5 GB (also without Playwright), an
  engine page grows by about 270 MB per load up to about 4.4 GB, then Firefox frees them all
  (#291). Chromium frees them right away (the renderer goes up and down between 0.4 and 1.6 GB).
  `cache-test` still opens a new tab between some of its sections (#288).
- `devices-test.mjs`, rarely in CI: the view stops rendering (no media query events, the page
  keeps its scroll position) while scripts still run, and every check after it fails. A view
  without a rendering update for twice 2 s now logs the state of its frame pipeline ("no rendering
  update for 2 s") and asks for the frame again; the compositor logs a frame that only its timer
  brought. On 2026-10-28 it showed the compositor 5 s in phase 13 (`flushCompositingState` of the
  layers, LayerTreeHostWasm.cpp): it waits for the lock of a `CoordinatedPlatformLayer` that another
  thread holds (not the engine thread, which logged it; scrolling or tile threads), after the
  page switched to the dark color scheme. On 2026-10-29 again 4 s in phase 13 but not in
  phase 131 (waiting for a layer's lock), so it waits inside a flush (the root layer, a backdrop's
  lock, or the update lock of a backing store, which `waitUntilPaintingComplete` holds while tiles
  paint); the log line now names the layer being flushed (-1 the root layer). 2026-10-29 again:
  layer 6 of 8, so the compositor holds that layer's lock and waits inside its flush (the
  backdrop's lock, the backing store's update lock in `takePendingUpdate`, or a buffer it
  drops); the lock order of the engine thread (parent, then child or backdrop) matches. Patch 0062
  records the step inside the flush; the next stall (2026-10-29) showed layer 7 of 8 at step 0,
  after its flush: `hasPendingBackingStoreTileUpdates` takes the layer's lock when the layer has
  no Skia target yet (its flush had nothing to do), so another thread holds that lock for
  seconds. Phase 132 now logs that case with the layer. The next one (layer 1 of 8, step 0)
  had no phase 132, so it waits right after a flush in `hasPendingBackingStoreTileUpdates` or the
  append (malloc); phases 133 and 134 tell them apart. It always follows a touch fling and a
  wheel scroll back to the top, and came in 4 of the last 8 CI runs. Since the split engine
  (#238): a stop at a place that cannot block fits a thread that reads a chunk of deferred code
  itself with a synchronous request that never ends; such reads taking over 1 s are now logged,
  and in workers the request gives up after 30 s and tries again.
- Flaky under load: `cache-test.mjs` (small quota cleanup), `mediastream-test.mjs` (recording
  sometimes short), the MSE `remove()` end of `media-test.mjs` (once 2.6 instead of 2.5 in Firefox), in Firefox once a white
  view in `paintworklet-test.mjs` without compositing, the memory check of `wasm-test.mjs`, "animation runs while JS blocks" in
  `compositing-test.mjs`, the hang checks of `ui-test.mjs`, `serviceworker-test.mjs` in parallel.
- Without tests: the sample count limit in fMP4 (`trun`), GC cleanup of host objects other than
  WebAssembly, Set-Cookie on a service worker update, the write timeout of databases (#180).
- The `profile` volume on the server has no backup.

## Later

- **Profile**: one profile per server, no login, no end-to-end encryption, files unencrypted on
  the server (so only internal or with a token). Planned: login with passkeys, several profiles,
  encryption in the browser (WebCrypto), versions to roll back. Sign-ins in big IndexedDBs
  (WhatsApp Web, Telegram Web) do not follow to other devices; changes of the last seconds before
  closing reach the server only at the next start of that device.
- **Navigation policy**: a host hook to allow, block or redirect navigations of the pages.
- **Engine from a CDN**: a same-origin worker trampoline so the large files can come from another
  origin.
- **WireGuard**: `WireGuardTransport` (user space TCP/IP and WireGuard in WASM, UDP over Wisp), so
  sites see another network than the relay's datacenter IP.
