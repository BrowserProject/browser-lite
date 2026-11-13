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
  React Router's `<Meta>` keeps the tab title after an in-site navigation (nzz.ch: the title
  stayed empty, the interpreter cached a missing `meta` export for all modules, #431). Compiled
  JS stays compiled through full GCs and in every frame (#455: before, a page's hot code ran
  interpreted for good after the first full GC, about 6x slower).
  Above 2 GB of engine memory the JS glue gets unsigned pointers (#465: before, uploads sent other
  memory of the page, the HTTP cache stored wrong bodies, compiled JS failed to install and
  `decodeAudioData` threw).
  `CompressionStream` and `DecompressionStream` take buffers of another realm (an iframe's
  `Uint8Array`, `ArrayBuffer` or `DataView`) like Chrome (#506; before they rejected them with
  "Invalid type should be ArrayBuffer", which twitch.tv logged from code of its Kasada iframe).
  The pages' WebSockets compress their messages like Chrome (permessage-deflate, #529; in
  the test 380 KB of messages take 2 KB on the wire instead of 381 KB). Before, every server that
  answered with a `Sec-WebSocket-Extensions` header failed the connection ("header is invalid":
  the comments and live feed of blick.ch over viafoura retried every 0.6 s).
- **Browsing**: views with popups (opener, name, sandbox; without a user gesture blocked with an
  icon in the demo that opens them or allows the site, #384; like Chrome one popup within 5 s of a
  click, also from a timer, #504), history incl. back/forward cache
  (address and title of the restored page, #367; the page left last stays through the automatic
  memory releases, so back shows it at once where it was scrolled to, #451), favicons for every loaded page (also after a
  page without one or back to a page whose next page never loaded, #389; like Chrome as soon as
  the head is parsed, following later icon changes of the page and also `data:` and `blob:` icons, #520; in the demo a tab from
  the last session shows the remembered icon of its site before it loads, #493; like Chrome a
  tab without an icon shows a globe, so narrow tabs are no longer a row of empty boxes, #510),
  `:visited` for the addresses the views loaded and those of the host's history (before, every
  link kept its unvisited color, in search results and on Wikipedia too, #480),
  downloads (a link or form whose answer becomes a download asks the server once, #412; the
  demo's panel follows a running one and cancels it, #466, and like Chrome keeps the list over
  a restart, with Download again and Retry, #491; a tab whose only navigation became a download
  closes again like in Chrome, a new tab page stays, #508; Save link as, Save image as and Copy
  image of the context menu like Chrome, the image at full size as PNG on the clipboard (checked
  in Chromium, Firefox and WebKit), and Download again and Retry request the address as a
  download, #511),
  uploads,
  find, zoom (per site in the demo, #385), pinch zoom on the compositor (#150), also while the
  page is busy (#505),
  a tab discarded under memory pressure, reopened (Ctrl+Shift+T) or from the last session back
  at the scroll position of its page like Chrome, also when the demo or the tab is closed right
  after a scroll (#440, #452, #453),
  print to PDF, view source in a tab directly after its page like Chrome (#468), `view-source:`
  addresses as pages with history, also typed into the address bar (#490),
  external schemes to the host after a click (#148), context menu data, link hover, fullscreen,
  HTTP authentication with Basic and Digest and a sign-in dialog like Chrome's (#257),
  synchronous `XMLHttpRequest`, where only its page waits like below a dialog (before it always
  failed with `NetworkError`, so Akamai's bot check reloaded amazon.de in a loop, #471),
  permission prompts like Chrome's that go away when their page is left and close with Escape
  in the view (#462; before, a prompt stayed over the next site and Allow stored the grant for
  the origin left),
  validation messages and the file input's label with their numbers and texts (#363), a typed
  `data:` or `about:` address without the Content-Security-Policy of the page before (#408),
  an address typed without a scheme over `https://` with a fallback to `http://` when the site
  has no working `https://`, and localhost, IP addresses and ports over `http://` like Chrome
  (httpforever.com, 127.0.0.1:7650 and localhost:7650 ended on ERR_SSL_PROTOCOL_ERROR, #435).
- **Input**: keyboard incl. dead keys and IME preview (#127), Backspace and suggestions of
  Android keyboards after typing (#411), clipboard with HTML and files
  (#126), copy buttons of sites through `navigator.clipboard.writeText()` and `write()` (text
  and HTML, #469; before, the promise resolved and nothing reached the clipboard), drag and drop
  (#125), also out of the page onto the embedding page, where the demo opens a link or text
  dropped on the tab strip in a new tab or the tab under it and one dropped on the address bar in
  the active tab like Chrome (#534: before, nothing outside the view could take a drag of
  the page), touch with pointer events (#316), swiping along `touch-action`
  without wheel events (#314) with scroll snapping and the engine's fling (#319), pointer lock, ctrl + wheel to the page first (#167), keys to the page before the browser's shortcuts like Chrome (an editor's own Ctrl+F, Ctrl+P, Ctrl+L, Ctrl+U underline, #436), and keys typed right after such a shortcut wait for the page's answer like in Chrome, so with a busy page (YouTube, Wikipedia) the letters after Ctrl+L or Ctrl+F all land in the address or find bar instead of reaching the page as its own shortcuts (#507), while plain typing does not wait, so keys typed during a 5 s engine stall reach the page within about 0.25 s after it instead of one engine round trip per key (#524), Escape stops a loading page like Chrome's Stop when neither the page nor a field of the demo takes it (#437),
  `buttons` and `pressure` of mouse and pointer events, also with chorded buttons (#370),
  Tab to links (#372) and color inputs (#535), focus on click of buttons, checkboxes and links like Chrome (#450), mouse leave of the view (`:hover` and link address go away, #381),
  the link address follows a dialog that appears under a still mouse (#481),
  mouseout and mouseleave on the first move after back or forward to a cached page (#398),
  taps under the overlay scrollbars at the right edge on phones (#413), no hover and mouseover from a
  scroll after a tap (#426), no link address bubble after a tap (#515), `PointerEvent.getCoalescedEvents()` with every host move a pointermove
  stands for (#492; before, empty for every trusted move). WebCore's own pointermove after a
  scroll still has an empty list, as in upstream WebKit.
  Input runs before the engine's queued work (#347), waiting mouse moves coalesce (#350), the
  parser yields after 50 ms (#349): on 20min.ch locally the 90th percentile of input latency
  during the load went from 3.5 to 0.8 s; a Moto G71 before the change: median 6 s, up to 23 s.
  Hidden views wait while the user types or taps in a visible one (#364), through the pauses of a
  writer while the focus stays in a text field and while a visible view loads a new page until it
  commits (#394): with weather.com loading in a background tab, typing in bursts with 2.5 s pauses
  went from median 0.42 s (90th percentile 1.1 s, up to 7.5 s) to 2 ms (frame 32 ms), a new tab
  next to two loading heavy tabs commits in 0.3 to 2 s instead of 11 to 17 s. After a pause of
  more than 10 s (or 1 s outside a text field) a key can still wait for a task that already runs.
  A hidden view that waits starts nothing at all since #531: its style and layout timers, the load
  events of its images and a parser resumed by a script that waited for a stylesheet started tasks
  of up to 3 s after the hold had begun. With Wikipedia, CNN and Spiegel in background tabs on a
  busy machine (load 16 to 28) the worst typing rounds went from median 0.2 to 0.6 s (up to 1.5 s)
  to under 12 ms (at most 0.23 s). Since #537 the hit test that WebKit runs 200 ms after a
  layout to find the element under the mouse waits too: in a tab the mouse had been over, it laid
  the held page out again (0.3 to 0.4 s per key burst in the test, every time in Firefox).
  A switch to a tab that loaded or changed in the background is urgent like input, its due frame
  comes before its own waiting tasks and hidden views wait for that frame (#419): with Wikipedia,
  20min.ch and weather.com opened by Ctrl+click, the page area stayed white for 0.9 to 14.9 s
  (median about 3 s) after the click, now 0.35 to 1.7 s (median 0.9 s). What remains is a hidden
  task that already runs at the click and the page's own first layout and paint. The core still
  shows an empty view canvas until that first frame instead of the last tab's frame.
- **Dialogs**: `alert`, `confirm`, `prompt` and `beforeunload` hold only their page like in
  Chrome; with an in-page dialog handler (a promise) the other views keep loading, running and
  rendering (#258). `@browser-lite/ui` shows them in the page by default (`pageDialogs`, #338).
  Reload and back/forward ask before they send a form (POST) again, cancel keeps the page (#369).
  Closing a view waits at most 500 ms for a busy page's beforeunload, like Chrome (#387): Ctrl+W
  in a row while heavy tabs load closes a tab per press. The host browser's color and date pickers open at the field
  (#371; on an iPhone or iPad their sheet keeps its width and 8 px from the window edge, #473) and close when the page removes the field or navigates (#424). The suggestions of `<input list>` show below the field like Chrome's dropdown, with
  Up, Down, Enter and Escape in the field (#403).
- **Rendering**: GPU raster with Skia on WebGL 2, compositing and async scrolling on own threads
  (smooth scrolls a page starts, such as `scrollTo` with `behavior: 'smooth'`, run without input, #366),
  no frame without a visible change (damage tracking, #220), a small change such as a spinner shown only in the damage tiles it touches (#454; on iPhone Safari 18 emptied tiles kept showing stale pieces of earlier frames and pages until #463), animations of only opacity and transform (pulsing placeholders and dots) run by the host browser itself without engine frames (#478, #518), the first paint right after the first visible layout, before
  waiting scripts (#246), frames between the tasks of a busy page (#359: 40 tasks of 100 ms got
  33 to 36 frames instead of 7 or 8), GPU blur and shadow, CSS Paint
  Worklet, WebGL 1 and 2 with the host's GPU named to pages (#496: on a host with SwiftShader Google
  Maps drew with WebGL, every frame held the engine thread about 650 ms in `readPixels`, its
  controls came after 20 to 70 s and a search often moved no map; now it leaves WebGL like Chrome
  there, controls after 4 to 10 s), recovery after GPU loss. WebGL also in dedicated, nested
  and shared workers on the worker's own thread, a canvas handed over with
  `transferControlToOffscreen` shows its frames with layers, and a drawing buffer with depth keeps
  the stencil a page asks for (#528: pixi.js took WebGL as missing and play2048.co said "Something
  went wrong while starting the game"; WebGL 2 had no stencil bits behind `stencil: true`). After a rotation or an on-screen keyboard the
  last frame stays unscaled until the page painted the new size (#404; before, it was stretched
  or squashed for seconds on heavy pages), and fractional pixel ratios stay sharp in Firefox and
  WebKit. Pages taller than 2^24 px show their content to the bottom (#409; before, all
  below about 16.7 million px was blank). Fast flings stay painted while the page's scripts
  hold the engine thread: the tiles where a moving view goes are made at once and painted after
  those in view, without holding the frame (#460; locally with 400 ms of script every 450 ms
  on average 5 to 21 % of the view and for 0.5 to 1.2 s more than a quarter of it blank, now 0). A filtered layer keeps the text shadow of its contents
  (#442; zoo.ch had hard dark boxes behind its headline with `filter: blur(0px)`).
  AVIF images decode (libavif with dav1d, also 10 bit, alpha and animated, #447): the engine sends
  Safari's user agent, so AliExpress sent its product pictures as AVIF, which showed as broken
  icons. A 1600 x 1067 picture decodes in about the time of the same WebP (46 against 47 ms,
  JPEG 30 ms, locally). Sites of the hot functions profile now send AVIF too (Accept), so the
  decoder's common paths are in `engine.wasm`: 90 KB more gzip for the start, 230 KB deferred.
  AVIF images no longer run the memory away (#488, patch 0107): each one decoded its whole
  picture only to learn its size and kept the dav1d decoder and the YUV planes until it was
  painted, and its reader kept the decoder alive forever, so every memory release that dropped
  the decoded images made them decode again and lose the old ones. vimeo.com grew by about
  35 MB/s while idle and crashed out of memory at 4.3 GB after about 2 minutes, figma.com too;
  now figma.com stays at 464 MB of engine memory for 150 s and a local page of 50 large AVIF
  images loads in under 5 s and stays at 369 MB (before: `load` after 40 s, out of memory after
  115 s). vimeo.com (2026-11-10) stays at 2.6 GB after 45 s: one task of 11 to 14 s about 30 s
  into the load takes 1.8 GB (in use afterwards 1.7 GB, JS heap 500 MB, decoded images
  145 MB, no AVIF decoder in samples of the engine thread), not looked into yet.
  The leak was also most of the higher peak memory found on 2026-11-10 with 20 heavy sites
  opened in tabs (40 s each, Chromium with SwiftShader, local): 1901 to 1971 MB malloc in use
  and 2116 to 2215 MB WASM memory at 21 tabs against 1348 to 1350 and 1607 to 1637 MB with the
  engine of 2026-11-06, which did not accept AVIF yet; amazon.de alone added about 390 MB. With
  patch 0107 (2026-11-11, two runs each, alternating): 1445 to 1458 against 1398 to 1416 MB in
  use, 1722 to 1744 against 1651 to 1676 MB WASM, amazon.de alone settles at 192 to 198 instead
  of 240 MB (the old engine 160 to 169 MB, its page has fewer pictures). What remains is the
  compiled JS kept while a page lives (#441, #455): after a release that deletes it 1337 to 1343
  against 1356 to 1368 MB in use, on cnn.com alone 266 -> 223 against 236 -> 221 MB.
- **Media**: `<video>`/`<audio>` (also `blob:`, `data:`), MSE, Web Audio, WebCodecs, camera,
  microphone, screen, MediaRecorder, WebRTC (opt-in), Picture-in-Picture, all through the host.
  Muted autoplay plays only in the view like Chrome: 20min.ch idles at 5 % CPU instead of 25 to
  29 % with its teasers below the fold (plain Chromium 6 to 7 %, #399). Transparent videos (VP8,
  VP9, HEVC with alpha) keep their alpha when frames are copied (#442; the filtered hero video of
  zoo.ch covered the photo with opaque green). A video in fullscreen shows its whole picture like
  the native players of phones, also with the page's `object-fit: cover` (#474; m.youtube.com
  fullscreens its `<video>` for the iPhone it sees and showed only a slice of the frame). The media
  controls show their icons (play, pause, skip, mute, fullscreen) and their exit button leaves
  fullscreen (#476; every button was blank and fullscreen had no visible way out).
  `navigator.mediaCapabilities` of pages and workers answers with the host's `decodingInfo`
  (#503; before it called every configuration unsupported, so Twitch's player dropped every
  variant of a stream and showed Error #4000; its front page stream now plays).
  `getVideoPlaybackQuality()` counts the frames of the host element, copied frames that never
  reached the page as dropped (#538; before, every count stayed 0, so YouTube, hls.js and Shaka
  never lowered the quality when frames dropped).
- **WebAssembly of pages** in the host engine, also memory64 and multiple memories (#152, #184).
- **Workers and storage**: service workers with soft update and navigation preload (`ready`
  resolves with the active worker set like in Chrome, #483: before, the registration still showed
  only the installing worker and `ready.active.postMessage()` threw; service and shared workers
  fetch `blob:` URLs of their pages like in Chrome, #484: before, every such fetch failed with
  "Load failed"), Cache API,
  OPFS, IndexedDB with limit (#179), CryptoKeys in IndexedDB, `structuredClone` and
  `postMessage` like Chrome (#527: before, every one threw `DataCloneError`, so WhatsApp Web
  never showed its QR code and reported a database error), cookies (also of a host that is itself
  a public suffix like httpbin.org or github.io, like Chrome, #533: before, all its cookies were
  dropped) and localStorage, all in an OPFS namespace (#142),
  HTTP cache in the host Cache API (#70), partitioned by site like Chrome (#213), with ranges
  (206, media pieces) like Chrome's sparse entries (#222).
- **Robustness**: watchdog for scripts that keep input or a call waiting (#146, #501), crash and hang detection with in-page restart
  (#147, #172), a service worker that does not stop (blocked in WebAssembly or the host's
  RegExp) is given up and no longer freezes the whole engine with every tab after 1 to 10 s
  (#512; seen after vscode.dev), its next event starts it again and a new version activates,
  hidden background views (#170), memory pressure near the memory limit found at
  runtime, also in 32 bit browsers with about 1 GB (#171, #216), from 512 MB on iPhone and
  iPad (#358; `moderate` there, `critical` only while the malloc area stays full, #497), error
  pages with the
  relay's reason and auto reload (#174, #175), also for a missing `file:` and an unknown
  `about:` address (#395) and for a restricted port or the address 0.0.0.0, typed or as a
  redirect target, where the view stayed blank before (#400), and for a redirect loop (more
  than 20 redirects) or a redirect to `file:` (#406), and like Chrome for an HTTP error status
  without a body (`HTTP ERROR 500`, before a blank page, #425), the error page as the only
  message: the demo no longer repeats it with curl's text in the status line or the phone
  layout's snackbar (#427), a request whose pooled connection dies before any response byte
  goes again on a new connection like in Chrome (#397), a new HTTP/2 connection opens more
  streams only once the server announced how many it allows, where www.postfinance.ch (limit 10)
  reset the rest and the page lost stylesheets and scripts (#479), the relay connects with Happy Eyeballs
  like a browser, so a site with IPv4 and IPv6 addresses whose IPv4 handshake is slow or loses a
  packet no longer fails after 0.25 to 0.5 s on a relay without IPv6 (neverssl.com, #415), dead relay detection (#177), fix of a WTF timer
  bug that aborted about 1 % of heavy page loads (#219), pages left behind no longer kept alive
  by old words on the C stack that the conservative GC scans (#296; soak test 0 of 15 local runs
  with pages that stay, before about 1 in 5; in CI 40 of 40 soak checks of 11 runs clean up to
  2026-11-02), and no longer by microtasks that waited when the page was left (#388: spiegel.de
  left after 4 s stayed within 1 to 10 visits in each of 9 runs, now in none of 25 visits), JS heap blocks from slabs so that freed ones are
  reused: after 48 heavy page loads in one tab 985 instead of 1235 MB of engine memory (#329),
  and the garbage of a long script is collected while it runs, also inside the generic calls of
  compiled code and without JSC's 256 MB bursts (#448): Cloudflare's Turnstile on kaufland.de no
  longer grows the WASM memory to 0.75 to 1.9 GB but to 440 to 550 MB with the page (3 local
  runs), a loop of 6 s full of garbage keeps the 256 MB it started with (before 369 MB). The
  code of pages and frames that are gone goes too: JSC's code cache kept the bytecode and the
  sources of every script evaluated until memory was short, now every memory release and every
  page a view leaves empty it (#475; 16 heavy page loads in one tab, then about:blank and a full
  GC, 2026-11-09 local: 474 to 525 instead of 573 to 619 MB in use, JS heap 39 to 61 instead of 71
  to 79 MB, and each release frees 105 to 206 instead of 54 to 115 MB). Closed tabs free their
  memory within seconds: a full GC follows once no view closed for 1 s and the user leaves the
  engine thread free (#498); before, JSC's timer alone collected their garbage, minutes later when
  the last full GC had freed little (10 heavy sites closed, 2026-11-10 local: JS heap 238 MB, 60
  documents and 1092 MB of malloc for about 4 minutes; now 5 s after closing JS heap 60 MB, 6
  documents, 563 instead of 1057 MB). An abort signal of a closed or left page no longer keeps
  it through its abort listener (patch 0128, like Chrome): a timeout, an `AbortSignal.any` or a
  Request's signal with a listener whose closure held its controller or document kept that whole
  page for good, on every run booking.com's main document with its frames (2026-11-13 local,
  Chromium: booking.com alone, 60 s after closing its tab 169 instead of 304 MB of malloc in use,
  101 instead of 253 MB after a critical release and a full GC, JS heap 0 instead of 58 MB, no
  document of it left; 20 heavy sites, each in a tab for 40 s, all closed: 359 instead of 923 MB
  after 60 s, 169 instead of 810 MB after the release, JS heap 0 instead of 48 MB). Still open
  there: about 100 MB above the start, 14 small documents of SVG images outside the memory cache
  and a CNN document that 24 of its nodes keep; the WASM memory keeps its peak (it cannot shrink).
  Closing tabs whose tiles still paint no longer crashes the
  engine (#514, patch 0113): their painting jobs ran after the view's layer tree host was freed
  and called into it ("table index is out of bounds", "function signature mismatch" or "null
  function" on a painting thread; 20 heavy sites opened and closed: 3 of 3 runs crashed, also the
  soak runs of 2026-11-09). Now the view's painting engine waits for them before the host goes.
  2026-11-11 local: `close-while-painting-test.mjs` crashed in all 8 Chromium runs within 2 to 9
  views and in Firefox, after the change in none of 7 Chromium runs of 10 to 24 views and 4
  Firefox runs; two runs of the 20 sites at once closed all tabs without a crash.
  A tab hidden for 10 s releases its tiles (#517, patch 0116), like Chrome: before, every
  background tab kept the textures of all its layers, which under SwiftShader and on integrated
  GPUs are system memory of the host's GPU process. 2026-11-11 local, Chromium with SwiftShader
  at 1280x800, the same 20 heavy sites one new tab each, 40 s per site, the build before and after
  in turn: GPU process 2859 MB at 21 tabs before (about 130 MB per tab, still growing), 1157 MB
  after (flat at 1.0 to 1.15 GB from the 11th tab on); after closing all but one tab 944 against
  638 MB, after a page in the last tab 865 against 616 MB. Local pages with 6 layers in 10 new
  tabs: 231 to 496 MB before, 235 to 398 MB after. Shown again, a tab keeps its last frame until
  its tiles are painted again (`hidden-tiles-test.mjs`). Left: plain Chromium grows about 18 MB
  per tab (388 MB at 10 tabs against 889 MB here); the GPU process keeps freed texture memory for
  reuse rather than giving it back, so its size follows the heaviest pages seen, and each tab
  keeps its last frame in its canvas.
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
- **Weak devices**: a page being left pauses until the next page answers, so a busy page no
  longer holds up the next one on the shared engine thread (#337); render resolution limit for
  high pixel ratio screens, the demo renders at most 2x by default (#231); video plays in the host's own `<video>` behind the view canvas (#232);
  after a browser restart the engine comes compiled from Chrome's code cache (#237); new threads get
  loaded web workers from a reserve that refills in the background, the engine thread no longer
  waits 60 to 180 ms for a worker to load (#242); a JPEG drawn at half its size or smaller
  decodes smaller, a 4000 x 3000 photo shown at 400 x 300 takes 0.7 instead of 46 MB of pixels
  (#270); the host polls gamepads only while a page uses them, so the idle demo no longer keeps
  Chromium's gamepad thread at 220 wakeups/s, a quarter of its idle CPU (#380); an image that is
  the contents of a compositing layer keeps its decoded frame, before the memory cache dropped it
  and every layer update decoded it again (vimeo.com: 39 to 53 % of the engine thread in WebP
  decoding after the load, now none, #432).
- **Fonts**: Noto for about 20 scripts, symbols, Chinese, Japanese, Korean and color emoji
  (COLRv1), loaded on demand in small slices (#229). Text with an emoji and VS16 keeps its font
  when the font cache is purged under memory pressure, before the next paint of it could abort
  the engine (github.com/lovasoa after an emoji page, #434).
- **Profile on the server**: cookies, localStorage and small IndexedDBs plus app prefs, only the
  last device writes (#188 to #191, #197).
- **Demo UI** (Material redesign of 2026-11-02, #345, on the refresh #339 to #341): tonal
  surfaces with a blue accent, design tokens in one place, state layers, tabs joined to the
  toolbar, light and dark mode, SVG icons, a new tab page with a greeting and tiles of the sites
  visited most often, an address bar that selects the whole address on the first click and
  restores it with Escape, keeps an address that is still loading (a slow server, a sign in prompt) in the bar and the tab until its page commits (#382), searches for an invalid address like `http://example.com:99999/` like Chrome instead of loading a mangled one (#407), a find bar that Escape closes also after a click on its buttons (#376), one find bar per tab that a navigation closes (#390), a find count that only shows the result of the text in the bar, `1000+` past the limit, and no search of the old text when the bar opens again (#464), Open link or image in new tab of the context menu in the background like Chrome (#391), a context menu with only Cut, Copy, Paste and Select all in a text field, Cut and Copy greyed without a selection, like Chrome and Firefox (#470), Ctrl+Shift+T for the tab closed last (#377), tabs reordered by dragging with the mouse and Ctrl+Shift+PageUp/PageDown (#383), closing the active tab activates the tab it was opened from or its right neighbour like Chrome and Firefox (#410), tabs opened from links right after their page in the order of the clicks and Ctrl/middle click on a `target=_blank` link in the background like Chrome (#416), Shift+click and Ctrl+Shift+click on a link in front directly after its page (Chrome opens a window for Shift+click; #438), a middle click on a tab closes it like Chrome and Firefox (#418), a click on a tab gives the keyboard back to the field of its page that had it like Chrome, instead of leaving it on the host page's body (#486), a menu on a right click on a tab like Chrome with New tab to the right, Reload, Duplicate, Mute tab, Close, Close other tabs, Close tabs to the right and Reopen closed tab (#521), the list of the tab's earlier or later pages on a right click or a held press (mouse or finger) on Back and Forward like Chrome, reached in one step with the new `view.go(offset)`, and Show full history (#522), a click on Back, Forward or Reload leaves the keyboard with the page like Chrome, so Space no longer presses the button again and PageDown scrolls the page (#487), inline completion of visited sites, Ctrl+Enter for `www.<name>.com` and Alt+Enter for a new tab in the address bar like Chrome (#420), text that only looks like a host (`node.js`, `vue.js`, `3.14`) searched like Chrome with the address offered after the search, and Ctrl+Enter `.com` for every host without a known top level domain (#489), an unfinished address bar edit per tab across tab switches, Escape back to the typed text after an arrow key choice and the page address after a `javascript:` address (#439), the address and the find text after Safari's Back and Forward to the demo (page cache, #422), suggestions with a search row and site icons, the menu as a dropdown,
  floating side panels, history by day, settings as cards with switches, dialogs of the pages in
  the page, hover only for real pointers, short transitions (off with reduced motion). Checked in
  Chromium at 1440x900, 1280x800, 820x1180 touch, 393x852 and 844x390, light and dark; not yet on
  real devices.
- **Demo on phones**: a phone layout below 640 px of width or 500 px of height like mobile
  Chrome with the address bar at the bottom (back, only the host in the address, tab count, menu;
  above the home indicator and the keyboard, suggestions upwards above it), tab overview with
  cards, menu and panels as bottom sheets on the bar with icon rows, touch targets of 44 px, safe
  areas, sheets above the iOS keyboard, the context menu inside the page above the bar (#361),
  a link opened from the context menu with a message that offers to switch to it (#391),
  the settings' close button at the top while they scroll (#379),
  settings section chips as wide as their names, so "Device and browser" stays on one line on
  an iPhone (#445),
  the empty bookmarks sheet names the menu's Bookmark button, not the hidden star (#428),
  a long press shows the address of the pressed link or image and only its commands, no page
  commands (#429), the page keeps its size under the keyboard of the address bar and the demo's
  other fields instead of being laid out again, like Chrome (#444),
  checked on emulated phones, the tab overview cards also on an iPhone with Safari 18 (#378); Android hosts get the iPhone or iPad identity by default (#332);
  rotating the phone rotates the pages (#336); the host's back (Safari's button and edge swipe,
  Android's back gesture) goes back in the tab and leaves the demo only at the tab's first entry
  (#414; like Chrome's the new tab page is that first entry, so Back after the first address
  typed into a new tab returns to it instead of leaving, #513), the host's forward and the mouse
  forward button go forward in the tab also while it can
  still go back (#467), the bottom bar slides away while the user scrolls a page down and comes
  back when they scroll up, like Chrome's toolbar (in landscape on a Pixel 9 the page got 235 of
  279 px with the bar; #472, checked on emulated phones, not yet on a device); it comes back with
  the progress at once when a page starts loading and stays until the new document commits, also
  for a link tapped while the page still loads (#494); the find bar takes the toolbar's place like
  in Safari and mobile Chrome and the page ends above it, so the current match is no longer
  hidden under the bar (#523; checked on emulated phones; on the device report the remaining
  case was toureiffel.paris, whose fixed banner covers most of the screen and hides the match
  in Chrome too, as Chrome's find also ignores fixed and sticky boxes).
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
  on a Pixel 9 (2026-11-04) Chrome's on-screen keyboard opens at a tap into a field and closes
  when the field loses the focus (#360); on an iPhone 16 (2026-11-05) the keyboard shows the
  page field's enter key, search in Google's search box (#392), and search fields without
  `enterkeyhint` (Wikipedia) get the search key (#443; on a Pixel 9 on 2026-11-06 Gboard shows
  it for a textarea with that hint like the IME field); on a Pixel 9 (2026-11-06)
  Gboard's Backspace deletes after typing and its suggestion replaces the typed word (#411); on an
  iPhone 16 (2026-11-06) the keyboard's previous and next field arrows step through the page's
  fields instead of reaching the address bar (#423);
  a single line field without `enterkeyhint` gets Chrome's keys instead of the textarea's return
  key: next when a field of its form follows, whose Enter moves the page's focus there, else go,
  go on iPhone and iPad (#495; covered in Chromium and Firefox by `core/ime-test.mjs`, not yet
  checked with Gboard on a device, the one BrowserStack session was taken);
  muted autoplay video on iPhone, Galaxy S23 and macOS Safari, video with sound after a tap on
  iPhone (#295); on 2026-11-01 with the JIT and the slabs of #329 two rounds of YouTube, GitHub,
  BBC, Stack Overflow and Wikipedia in one tab on an iPhone 16 without a crash or restart. Firefox
  runs every suite in CI (open failures below); the 54 real sites of `tests/compat` load in
  Firefox 155 too (2026-11-01, locally under Xvfb, CNN 12.8 s, weather.com 5.0 s), and on
  macOS Safari 18 CNN, The New York Times, Amazon, Google search and Maps (WebGL), Reddit,
  Spiegel and SBB one after the other in one tab (2026-11-01). The compatibility run goes on
  when its host browser dies during a site (#396), and it reports a failed host page or engine
  start as such instead of as a hanging site (#430).
- **Extensions**: a plugin system for integrators ([extensions.md](extensions.md), #280 to
  #282): request handler chain, scripts (isolated worlds) and CSS in pages by match patterns,
  messages, storage, UI slots rendered by the demo; no extensions yet, and without one nothing of
  it runs.
- **Yardstick**: 257 of 280 checks like Chromium.
- **CI and deploy**: every push to `main` builds, tests and deploys the public demo;
  all jobs on GitHub-hosted runners, the server sits behind a Cloudflare Tunnel and the deploy
  logs in over SSH through it with a key of its own and an Access service token (#335, #482).

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
The HTML standard (one page of 16 MB, local copy) kept the engine thread busy for 38 to 47 s of its
load and host commands waited up to 18 s: every burst of late fallback fonts rebuilt the style of
the whole page. Now only the elements with such text are laid out again: 22 to 35 s, waits of
about 9 s, the rest is WebKit's own layout and style of the long document (#401, #349).
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

On a real low-end phone (Motorola Moto G71, Android 11, BrowserStack, 2026-11-01), with the
engine started, from the load of a page to first paint / loaded: Wikipedia (Switzerland) 5.6 /
8.2 s, BBC News 4.9 / 13.3 s; with the JIT the same within the spread (one run each).

Through the public demo (2026-11-02, BrowserStack, Socrates tests T1 to T4): on the Moto G71 a
cold start straight into BBC News showed its header after 16.4 s and the first headline after
about 19 s; YouTube, opened while 20min.ch was still loading, committed after 3.9 s instead of
about 17 s before #337; Big Buck Bunny played, Google Maps could be dragged. On an iPhone 15 the
first start painted example.com within 12 s without waiting for a chunk (1.3 s before #342),
Wikipedia after about 2 s, an article after 1 s, back at once; rotating re-laid out the page
(#336). macOS Safari 26 and Windows 11 Firefox: tabs, find, zoom and downloads like a desktop
browser (Safari keeps Cmd+L, T and W for itself).

## Open: performance (by value)

1. JavaScript of a page load, flat (2026-11-01, weather.com, 13 to 21 s of the engine thread):
   parse and bytecode 1.5 to 1.9 s (8 to 11 %), JS runtime about 2 s, interpreter slow paths 1.2
   to 1.5 s, interpreter 0.9 s, compiled code 0.9 s, no function above 0.2 s. A persistent
   bytecode cache hit but brought no measurable gain (#215). The JIT (#322, #324,
   [jit.md](jit.md)) runs Octane 2x faster in Chromium and 3 to 7x on an iPhone, the TypeScript
   compiler 17 %; page loads gain nothing (their code runs once, #327). Compiled code calling
   functions not compiled yet goes through JSC's generic call with a VM entry each time.
   20min.ch (2026-11-03, profiled with consent): forced flex/grid layout from scripts 21 %,
   regexps 15 % (now in the host's RegExp when expensive, #348), 75 % of the JS in the
   interpreter, ads about 38 % (no ad blocker: owner decision 2026-11-03). Tapping an article
   there (a `pushState` route change of React) keeps the engine thread busy for about 10 s
   locally (2026-11-04; Pixel 9 about 13 s, iPhone 16 4 to 5 s): the URL changes after 1.5 to 2 s,
   the article shows after 9 to 11 s, in tasks of up to 2 s. Profile: lazy compiling of functions
   10 %, regexps 10 %, forced layout 17 %, the rest JS in the interpreter and the JIT. Expensive
   regexps were measured in the interpreter again after every GC or memory release, now their
   decision stays (#362). The memory releases above 192 MB deleted all compiled JS of the page,
   on 20min 8 to 10 times in the first 2.5 minutes (up to 5 within 10 s after the consent), and
   the page parsed, built and compiled it again; they now keep it until memory is short (#441).
   2026-11-06, local, 4 runs each: the new title after 9.3 to 11.3 s instead of 11.2 to 12.4 s
   (the URL after 1.0 to 2.2 instead of 2.1 to 3.3 s), back after 7.5 to 11.9 instead of 8.4 to
   18.3 s. Plain Chromium on the same machine: the title after 0.8 s, the article within 1 to 2 s,
   back after 2 s; 20min shows no pressed state there either. The rest of the gap is JS (the
   interpreter and its slow paths 24 %, compiled code 8 %, built-ins 7 %, parse and bytecode 6 %)
   and style and layout (22 %) of React, ads and analytics. Even with no input the page keeps the
   engine thread busy a third to half of the time in entries of 0.2 to 1.4 s (idle callbacks,
   intersection observers, timers of ads), so a tap often waits behind one. What is left of the
   input latency are single long entries (a script, a microtask checkpoint, the load event with
   its forced layouts); yield points between deferred and async scripts would split some.
   blick.ch (Next.js, 2026-11-09, local, 412x860; the report: 25 to 30 s on a Moto G71): after a
   tap the new route is in the DOM after 7 to 8 s (plain Chromium 3.5 to 6.6 s with the data
   fetch), Back shows the home page after 5 to 7.5 s (Chromium under 1 s). The page got few frames
   meanwhile: a pass of the engine's local tasks ran a pile of RunLoop pumps back to back (#477);
   now 77 to 105 frames in 12 s instead of 27 to 56 and the new route on screen 0.8 to 1.1 s after
   it is in the DOM instead of 1.3 to 2.3 s. What is left is page work: React rendering the
   route, ads and analytics in the interpreter and the JIT, forced layout (a quarter), a single
   task of about 0.9 s that commits the route, and on Back in some runs a canvas ad on the
   article whose animation frames (2D `drawImage` with rotation on the CPU, about 30 ms each)
   took 57 to 61 % of the engine thread while the home page rendered. Like Chrome the demo shows
   no progress for a same-document navigation (`pushState`). 2026-11-12 (the report: a Moto G71
   showed the article after 13.5 s and the home page 14 to 16 s after Back, in tasks of up to 3.9
   and 6.6 s): from the tap to the article's title in the DOM Chromium's renderer is busy 0.75 s
   (blick's route 0.2 s, viafoura 0.17 s, style and layout 0.15 s), here 6 to 7 s. blick's
   styled-components insert about 300 rules with `insertRule()` on a tap, and every one that a
   style update met restyled the whole document and laid it out again: 105 to 135 ms per rule on
   the home page (Chromium 1.3 ms). WebKit invalidated all style for any change of an active
   sheet, and each new style resolver made the faces of all `@font-face` rules anew, whose fonts
   then counted as loaded again and restyled and laid out everything once more. Now such a rule
   restyles only the elements it may match and unchanged rules keep their faces (#530): 10 to 16
   ms per rule. During the tap style, layout and resolver builds took 18.5 % of the engine thread
   instead of 24 %; the title came after 6.5 to 7.9 s (median 6.9) instead of 6.8 to 8.7 s
   (median 7.1), Back 5.5 to 7.6 s instead of 6.9 to 9.3 s (5 runs each, noisy). What is left of
   them is building the resolver for every update with new rules (6 % of the engine thread
   during the tap) and the JS of the route, comments and ads, about 8 to 10 times Chromium's.
   blick.ch's first load (2026-11-11; the report: a task of 12.6 s on a Moto G71 after the load,
   the bar and flings without answer meanwhile): that task is React's hydration, one task in Chrome
   too (0.4 to 0.85 s on this machine), here 3.5 to 8 s. Its render ran without GC and with a
   walk over all CodeBlocks at many trap checks (#516): now the WASM memory after it is 368
   instead of 442 MB, its length is unchanged within the noise. Without the JIT it takes 2.5 to
   2.8 s instead of 3.3 to 3.6 s: in such cold code the calls between compiled and interpreted
   functions cost more than compiled code saves ([jit.md](jit.md#measured)), open.
   Long single tasks of a page become many times longer here, so they block all views (the
   script watchdog stops only those that keep input or a call waiting, #146, #501). Cloudflare Turnstile on kaufland.de (local, Chromium host):
   every challenge brings a VM obfuscated anew (other function names and sizes each run), so its
   work differs from run to run. It blocks the engine thread in single entries of several seconds:
   on 2026-11-05 up to 30 s, which the watchdog terminated, the widget staying at "Verifying". On
   2026-11-08 the challenge's first phase (until its `pat` request) took 8.5 to 60 s, median 18 s,
   before (16 runs) and 9.6 to 17.6 s, median 12 s, with the changes below (7 runs); the longest
   entry within a minute 6.5 to 36.7 s (1 run above 30 s) against 7.7 to 22.7 s, a median of 10
   to 11 s in both, as later phases do more. Plain Chromium with a desktop user agent on the same
   machine: the challenge's renderer is busy 3.2 s, its longest tasks take 0.8, 0.55 and 0.34 s.
   Sampling the JS stacks at the watchdog's trap checks
   (2026-11-08) showed that after the first full GC (a memory release about 29 s in) every hot
   function of the challenge ran interpreted to the end, 73 % of the samples: a compile stopped
   the tier-up counter that all CodeBlocks of a code share, and the GC throws away CodeBlocks
   after 5 s (#455); now 9 % interpreted. Its handler calls through `f["call"](a, b)` (29 % of the
   samples of one phase) and bound functions call their target directly (#456), loops entered
   once get V8's optimized code (#457), jumps forward and dense switches branch directly (#458).
   What is left is compiled code, half of the engine thread: the VM's functions of 40 to 90 KB of
   bytecode become about 1 MB of WASM each, which V8 runs in Liftoff for seconds before its
   optimized code is ready (phase 4 of [jit.md](jit.md)); then `get_by_val` with string keys 7 %,
   array literals 4.5 %. Its garbage no longer stays (#448), but while the challenge runs
   malloc's use still rises by about 3 MB/s with a JS heap of about 25 MB (2026-11-07, not
   found yet). OpenStreetMap's sign-up (2026-11-11, local, Chromium host, load 3 to 10): the
   widget shows its checkbox after 45 to 75 s (plain Chromium within 30 s, its challenge frame
   busy about 3.5 s in all, longest task 0.95 s); the challenge's longest entries take 9 to 23 s,
   up to 40 s at a load of 28. The engine thread was busy 56 of 70 s: compiled code itself 41 %,
   `get_by_val` 6 % (with the DOM getters of the window it reads), `new_array` 3 %,
   `put_by_val` and `===` of strings 2 % each; the slow path of `if` and `!` on strings and
   doubles (1.5 %) is gone, compiled code decides them inline now (#502). Under load such an
   entry passed the limit of 30 s and its termination left the widget at "Verifying...
   Stuck?"; the watchdog now stops a script only once input or a call waited its limit for it
   (#501), and the demo's "Wait" gives it the limit again. (brunhild.challenges.cloudflare.com has only IPv6 addresses, which this
   machine lacks; plain Chromium fails it too and still shows the checkbox.) LinkedIn Learning
   (2026-11-06, the PerimeterX bot script `client.protechts.net/.../main.min.js`, which plain
   Chromium also loads, its main thread 10 % busy then): after the load the engine thread answered
   no eval for up to 10 s, about 35 s in all, then recovered. Its hashing loops now run inline
   (#424). Its profile was an obfuscated VM calling small functions from one site, which the cache
   per call site missed every time (the C++ path of calls 15 % of the engine thread, generic calls
   8 %): calls now go through a callee table of the VM and compiled callees are called in WASM,
   such a dispatch 1.5 to 2.2 times faster (#459). On 2026-11-08 the freeze no longer showed, with
   this engine, the one before it and that of 2026-11-06 with its own core alike (the longest wait
   for an eval 2 to 4 s in the first 30 s after the load, then below 0.3 s):
   PerimeterX sends less work now (plain Chromium 4.4 % busy), so the gain on the page itself could
   not be measured. What is left for such scripts is compiled code itself (values in locals,
   inlining, phase 4 of [jit.md](jit.md)).
2. WebGL contexts of page scripts (feature checks, fingerprinting): every synchronous query of the
   shared host context waits for the GPU process, which is slow while it is busy (a live video,
   compositing). A switch between contexts read the whole GL state back (about 100 queries, more
   with texture units in use); on twitch.tv (Kasada's fingerprinting next to the autoplaying
   stream) that was about half of the engine thread in the first 40 s, a context creation took
   0.8 to 3.9 s. The state is now tracked instead (#449): 2 queries per switch (the errors), on
   twitch.tv (2026-11-07, local, 25 s profile while scrolling) the creation of contexts went from
   10.1 to 2.9 s of the engine thread and all host GL queries from about 10 to 4 s. What is left
   are WebKit's own queries while it sets up a context (`GraphicsContextGLANGLE::reshape`: clear
   values, masks, framebuffer status) and its `getError` after calls such as
   `getInternalformatParameter`, cheap with the in process ANGLE of native WebKit. The stalls of
   up to 10 s in twitch.tv's first 30 s stay, now mostly JS (the Kasada scripts in the interpreter
   and the JIT, see 1.). On a Motorola Moto G71 (real GPU) a context with a few queries took 89 ms
   the first time and 28 ms each after (before #449).
3. Forced flex/grid layout from JS (20min about 6.5 s, #141) and after a resize or rotation
   (#405, #461). WebKit laid out every box with a percentage height again whenever its parent
   or the block its percentage resolves against was laid out, and forced a relayout of every
   flex item with such descendants (FIXME webkit.org/b/204318); on 20min.ch, whose content
   column is a stretched flex item with about 300 `height: 100%` boxes and images below it,
   one small change laid out most of the page several times. Patch 0098 lays such a box out
   only when the height its percentages resolve against changed (#461). On 20min.ch
   (2026-11-08, local, interleaved A/B) a forced relayout after a 3 px change in the content
   costs 28 to 31 ms instead of 52 to 58 ms, a full one (body width) 40 to 43 ms instead of 63
   to 72 ms; native WebKit needs 35 and 43 to 50 ms, Chromium 0.1 and 3 ms. A resize still
   blocks the page's thread 0.6 to 0.8 s here (0.7 to 1.0 s before, Chromium 0.1 s): with a
   profile about half of it are the page's own `matchMedia` listeners (React re-renders, JS
   speed, see 1.), then style and layout. What is left of layout: a stretched flex item whose
   content changed is laid out twice, without and with its stretched height, and its
   percentage descendants with it; Chromium keeps a layout result per set of constraints for
   that, which WebKit has no place for. Wikipedia (no percentage heights) is unchanged. A window
   drag is coalesced: 3 resize events for 20 steps (native WebKit 20).
4. GC 5 to 7 % on JS-heavy sites (#60, #122).
5. Video and animations: with compositing Chromium shows the video itself behind the view canvas
   (#232); videos with opacity, blend modes, filters or 3D transforms keep frames painted into the
   tiles of the view, locally under SwiftShader 1.8 to 9.7 video frames per second against 25 to
   30 in Chromium (#217). Frames without a visible change are skipped since #220 (an
   animation outside the view took all CPU of the device before, now 0.03 CPU seconds per second
   on C); where every frame changes, a frame costs as much as before, and compositing only the
   damage cost more under SwiftShader (CI perf 39644894451 and 39670991733, #220).
   A frame with a small change goes only into the damage tiles it touches, small host canvases
   over the view canvas (#454): one 44 px CSS spinner (local, Chromium headless with SwiftShader)
   now costs 0.75 to 0.8 CPU cores at 60 frames per second at 640x480, 1280x800 and 1920x1080
   alike, before 2.5, 6.6 and 7.0 cores (39 frames per second at 1920x1080); Chromium itself
   needs 0.07. Many animations spread over the view (46 pulsing skeleton boxes, as on
   weather.com) touched more than half of the view and stayed whole frames; under SwiftShader a
   new view sized canvas frame costs the host about 100 ms of GPU process CPU at 1920x1080
   whatever it shows (#454). Layers that only animate their opacity are now shown by the host
   itself (#478): the page of 46 pulsing boxes (local, 2026-11-09, demo, 1280x800, 20 s standing
   still, same engine A/B) 0.14 to 0.16 CPU cores and no engine frame instead of 5.96 to 6.67
   cores at 52 to 55 frames per second (`BL_HOST_LAYERS=0`), the engine before 4.6 to 5.0 cores
   at 40 to 43 frames per second; plain Chromium 0.08. Layers that also scale and move, with the
   plain layers over them as a cover canvas, are shown by the host too (#518): Wikipedia's
   `mw-pulsating-dot` under the bookmark icon (World War II article, 1280x800, idle, local,
   2026-11-11, packaged demo, same engine A/B) 0.06 to 0.09 CPU cores and no engine frame instead
   of 0.65 to 0.71 cores at 43 to 46 frames per second (`BL_HOST_LAYERS=0`); plain Chromium 0.04
   to 0.05. In about 1 of 6 loads on a busy host the dot stayed in the frames for the page's whole
   life (40 to 45 frames per second), as its opacity and transform animations started 1 ms apart;
   since #539 they start on one clock reading. Still open: animations under effects, of filters, rotating or leaving their clip, and
   layers covered by later layers with effects, children or animations stay in the frames. On devices with a real GPU a whole view frame costs far less (not
   measured).

6. Images drawn small still decode at full size unless they are JPEGs or still WebPs (#270,
   #286): PNG, AVIF, GIF and animated WebP decoders ignore the subsampling level. A JPEG also
   decodes at full size for `img.decode()`, WebGL, `createImageBitmap`, `createPattern` and
   repeated CSS backgrounds, and keeps that frame for later small draws (like Safari).
   libwebp is built without SIMD (`-DWEBP_ENABLE_SIMD=OFF` in `deps/recipes/libwebp.sh`), so
   every WebP decoding runs its scalar code; its SSE2 paths with Emscripten's mapping to WASM
   SIMD are not tried yet (a deps change, to batch with the next one). vimeo.com still keeps the
   engine thread busy 30 s after the load without the decoding (#432): about 88 % of it JS
   (scripts, module evaluation, microtasks), not analysed further.
7. Memory of the host tab: with a trivial page the renderer of Chromium holds about 480 MB
   (2026-10-27, local): the engine memory (256 MB reserved, about 90 MB touched), about 220 MB
   of malloc inside the renderer that does not change with the number of workers (each spare
   worker about 4 MB) and is most likely V8's data of the 44 MB `engine.wasm` and the chunks,
   34 MB of compiled code; after bbc.com/news 720 MB, after CNN 960 MB. Smaller only with a
   smaller module. After 12 heavy page loads in one tab (2026-11-01, `/proc/<pid>/smaps`) Chromium's
   malloc grew from 290 to 590 MB and V8's code from 28 to 150 MB (with `BL_JIT=0` 530 and
   110 MB); from the second round of six sites on, the renderer outside the engine memory stays at
   0.9 to 1.1 GB, only the engine memory keeps growing (#329). In use after releasing everything
   and a full GC, 5 rounds through 8 heavy sites in one tab (2026-11-05, with #388): 48, 153,
   161, 158, 171, 178 MB of malloc, not yet broken down (caches outside `releaseMemory`, compiled
   code, the SQLite files of the visited sites); a document can stay until the next round while
   a load of it ends.
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
   a worker pays off for hosts with long tasks of their own, not for the demo. The demo's own
   biggest long task, the favicon readback from a GPU canvas (0.03 to 3 s per new site in
   headless Chromium), reads back on the CPU since 2026-11-05 (1 ms, #375).
10. Every SQLite commit still appends its record to the commit log on the committing thread
   (#302), for cookies the engine thread: one OPFS write per commit, so a slow disk still costs
   the engine thread one write for each cookie a page sets. The full writes of the databases no
   longer do (#446): on edition.cnn.com (2026-11-06, loaded machine) the engine thread had
   stood still for 3 to 13 s writing a 24 KB cookie database frame by frame, now no pointer move
   waits longer than about 1 s.
11. Huge documents (2026-11-10, local copy, Chromium host, 1280x800): iana.org's IDN table
   (14 MB of HTML, 12,000 rows, collapsed borders) loads in 14 to 15 s, as fast as Playwright's
   native WebKitGTK on the same machine (13.5 to 15 s); Chromium 4 to 4.5 s. It took 17.5 to
   21.5 s before (48 s under a load average of 19): every cell at the edge of the table looked
   through its whole column for the widest border half while it painted (WebKit 308969@main),
   after a layout working out each border anew, seconds per frame; now the table keeps them
   (patch 0106, #485). What is left is WebKit's table layout at WASM speed: laying out each cell
   with its `inline-flex` tags (9 s of a 25 s profile), work over the whole table in every
   rendering update (row positions, all collapsed borders, column widths, about 3 s) and whole
   relayouts after the page's scripts and after lazy fonts arrived (2 to 3 updates of 1.7 to 3 s).
   Rendering updates take three fifths of the load; a parser working as long in one go as the
   last update took (up to 500 ms) made 8 instead of 28 updates, each longer: iana no faster,
   html.spec.whatwg.org 42 and 65 s instead of 21 and 30 s (Chromium 7.4 s), so the slices stay
   at 50 ms (#349, #485). html.spec.whatwg.org spends most of its load in two rendering updates of
   5 to 6 s after parsing, not looked into yet. The engine kept answering throughout (an eval ping
   took at most 4.6 s).
12. Long articles right after the first paint (2026-11-12, local, Chromium host, first visit,
   eval pings every 200 ms): en.wikipedia.org/wiki/World_War_II held the engine thread for up to
   1.5 to 1.9 s in one task (unloaded machine; 7.5 to 9 s under a load average of 40). That task
   is the first rendering update of the whole article: style, the grid and flex sizing of the
   skin and the 700 references in balanced columns, plus code the host compiles on first use and
   fonts loaded on demand. Balancing laid the references out 3 to 4 times per layout, 7 layouts
   during the load, about 100 ms each with a warm engine; native WebKitGTK the same (a relayout
   of the article 160 to 170 ms with columns, 60 ms without), Chromium about 40 ms either way.
   Patch 0118 lays out again only the blocks that meet a column boundary (#519): a relayout of
   the article 84 to 135 ms instead of 147 to 218 ms (80 to 87 ms without columns), the longest
   wait of a ping 1.24 to 1.51 s instead of 1.52 to 1.91 s, the waits summed over the load 25 %
   lower (warm engine: longest 455 to 526 instead of 647 to 678 ms, sum 40 to 60 % lower). What
   is left of that task is the first layout itself at the speed of freshly compiled code; an SVG
   image is still set up (parsed and laid out) in the task that receives it, as in WebKit.
   www.nytimes.com: one deferred classic script (the app bundle hydrating the page) runs 2.5 s in
   one go on an unloaded machine, more than 11 s under load; JS in the interpreter and the JIT
   (see 1.), and about 5 % fontconfig lookups of the families its styles name in other weights
   and styles. A script cannot be cut into slices; it waits for faster JS.

## Open: features

- Media controls: no overflow menu (playback speed, subtitles, chapters) like Chrome's three dots;
  `MEDIA_CONTROLS_CONTEXT_MENUS` is off for the port and would need the menu of the media controls
  in the host (#476).
- Clipboard: an image (`image/png`) in a `ClipboardItem` of `navigator.clipboard.write()` does not
  reach the host, only text and HTML do (#469; the event `clipboard` carries no files). Like
  WebKit, a write with several items resolves, Chrome rejects it.
- Typed addresses (#435): the engine commits its error page of the failed `https://` load before
  the core falls back to `http://`, so the page shows for a moment and the failed address stays in
  back/forward before the `http://` page (Chrome keeps one entry). Falling back in the engine's
  `dispatchDidFailProvisionalLoad` instead of showing the error page would avoid both. No
  fallback timer: a host that drops connections to port 443 falls back only after the connection
  timeout.
- Downloads (#466): no Pause like Chrome; the core would need to hold the download's request in
  the engine (no reads, so the server waits) and resume it, or ask again with a `Range` header.
  Download again and Retry of the demo (#491, #511) request a download from a form POST again
  with GET. Save image as downloads the address again instead of the bytes the page shows (Chrome
  takes them from its HTTP cache), so an image whose address answers differently every time
  (a captcha) saves another picture; Copy image takes the shown one.
- Tab menu (#521): no Pin and no tab groups like Chrome; Mute tab mutes the tab, not the site
  as Chrome's Mute site does. No menu on the cards of the phone layout's tab overview. Close other
  tabs and Close tabs to the right put every tab into Reopen closed tab on its own, Chrome brings
  them back together.
- Touch selection: a long press selects the word, but there are no selection handles to extend
  it like Chrome and Safari on phones (needs the selection bounds from the engine and commands
  that move either end).
- `timeZone` applies only at `createBrowser`; the demo restarts the engine for a changed device
  too, although `Browser.setDevice()` could apply it (it uses that only for the rotation, #336).
- Pinch zoom: `visualViewport` events only at the end of the gesture; two fingers wait for the
  page's touchstart answers even without blocking listeners (the zoom catches up with the kept
  movement, #505), where Chrome zooms at once.
- Background views: `scheduler.yield()` and `postTask` are throttled like nested timers; video
  without an audio track pauses when hidden like Chrome (not after PiP, #170, #386), but only when
  the view becomes hidden: video a page starts in a view that is hidden from the start (a tab
  opened in the background) or starts again while hidden plays on, and the host decodes it
  (WebKit acts only on the change of visibility, needs a patch next to 0042). Muted video with an
  audio track plays on hidden (#170) and the host decodes its picture too (CNN: two such loops);
  discarding under memory pressure does not spare tabs with beforeunload listeners and input.
- Memory: a single page that needs more than the limit (about 1 GB in a 32 bit browser) or one
  allocation bigger than the 128 MB reserve can still crash the engine (#147, #216). On iPhone
  and iPad iOS ends the whole host page instead (all tabs lost); the 512 MB budget there (#358)
  discards background tabs early, but a single page far above it is not stopped. Android Chrome
  has no budget yet (no kill seen so far). Above the budget memory counts as short only while the
  malloc area stays full after a release (#497): the area never shrinks, so before one heavy page
  (CNN at a phone's pixel ratio 3, about 530 MB) made every later growth drop the compiled JS and
  the page left last and show the message with one tab. With no background tab left to discard
  and memory short the demo says that the page uses the memory (#373), again at every growth by
  32 MB.
  News sites with their ads reach the budget with two tabs (#417): on an iPhone 16 with the
  shared profile (consent given, so all ads load) nzz.ch alone holds 331 MB of malloc in use (JS
  heap 59 MB), The Guardian 267 MB after releasing everything, so nzz.ch plus one more page
  passes 512 MB with the area about as full as it is big (no leak, no fragmentation worth
  speaking of). Without the budget the engine froze silently at 775 MB of engine memory after
  three such tabs (2026-11-06; earlier iOS ended the page at 1.15 and 1.36 GB, and a freeze on
  spiegel.de at 1.1 GB on 2026-11-03), so the budget stays. Lower only with lighter pages: most
  of the malloc in use is many small blocks of DOM, style and JS of the page and its ad frames,
  JS heap slabs and decoded images; tile buffers waiting for the compositor add up to 20 MB at a
  phone size while a page paints.
  What iOS ends is the footprint of the whole Safari page, and most of it is outside the engine
  memory (2026-11-12, iPhone 16 with iOS 18, BrowserStack; a page fills memory with
  incompressible data until iOS ends it, so the room left is what the page did not use): a plain
  page ends at about 3.9 to 4.3 GB, and one shared WebAssembly memory grown to 4 GB and filled
  ended nothing. The demo idle on `about:blank` leaves 2.6 to 3.1 GB of it, with CNN loaded for
  60 s (engine memory about 650 MB, consent not given) 64 MB; with `gpu=0` 352 MB, with
  `BL_JIT=0` 672 MB, with both 1440 MB (one run each, the end varies by about 400 MB). So the
  JIT's modules compiled by the host and the GPU raster's textures cost about 0.3 to 0.7 GB
  each on CNN, and some 2 GB are neither the engine memory nor those. In Playwright's WebKit on
  Linux the core host page holds 1.5 GB idle at pixel ratio 3 against 0.95 GB at ratio 1, about
  0.5 GB of it white pixel buffers that grow with the square of the ratio, also with `gpu=0`; not
  found yet whose. Open: break the host side down further and lower it (a code budget for the
  JIT's modules, the textures, those buffers); the 512 MB budget of the malloc footprint only
  stands in for it. Since #525 the engine of a page that is left ends also into the
  back-forward cache, its memory takes a smaller reservation when 4 GB of address space are not
  free (the restart that failed with `Engine start failed: RangeError: Out of memory`, and a new
  demo in a tab whose earlier demo Safari kept, which hung at "Starting engine"), and the demo
  brings its session back when iOS ends the page (#526). In Safari's back-forward cache the left
  demo still holds two of the three 4 GB reservations of the process although its engine ended
  (in Chromium and in Playwright's WebKit the memory is garbage at once); most likely the main
  thread's pending `Atomics.waitAsync`, whose answer waits for the cached page's event loop.
- beforeunload: the host tab asks on close once a view with a listener had input, even if its
  handler would not ask; listeners only in iframes do not ask on close.
- WebAssembly: shared memory (threads) and JSPI (#153; `validate()` says false, so pages take
  their variant without); cycles between page and module are freed only with the page or worker.
- CSS: `url(#...)` and SVG filters on the CPU; filtered layers with children, masks or video
  recompute every frame; a layer with a blur or drop-shadow filter whose contents paint nowhere
  beyond the filter's outsets still cuts their shadows off at its box (WebKit keeps no visual
  overflow without the outsets, #442); `interpolate-size`; Paint Worklet scripts are classic (no
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
  does not). A transparent video the host shows behind the view canvas (overlay, #232) shows the
  host page through its clear parts instead of the page content under it; only copied frames
  keep the alpha (#442). A fix would find the alpha in a decoded frame and refuse the overlay;
  no media API tells it.
- Service workers: Push, Background Sync, Background Fetch.
- Network: WebTransport, streams as request body, Storage Buckets,
  WebSocketStream without read backpressure (#120). Fingerprint (#283): no GREASE, OpenSSL's
  extension order and point formats (JA3 and peetprint differ from Safari's), Safari's header order
  only approximated for header sets not measured (cross-origin GET, beacons); the TCP/IP
  fingerprint is the relay's.
- Storage: localStorage reaches SQLite 100 ms after a change (#303), a change in the last 100 ms
  before the tab closes can be lost; with `/data` in memory (second tab) uploads sit in WASM
  memory. WebKit's memory cache is shared by all views of a running engine, only the HTTP cache
  is partitioned (#213).
- Measurement: layout shift and long animation frame entries, IdleDetector,
  `document.featurePolicy`.
- UI: drag and drop outside a drop target opens nothing (#125; Chrome loads the link or file in
  the same tab, deliberately not here because an accidental drop would replace the page). A drag
  out of the page reaches the embedding page as untrusted drag events, so a text field there
  inserts nothing unless the page does it in `drop` (#534).
- Devices and identity: passkeys (WebAuthn has no authenticator, #298), password credentials,
  Payment Request, Web MIDI/USB/HID/Serial, WebXR.
- Extensions: no blocking or observing of requests (an engine export for WebCore's content
  extensions or a URL filter; for privacy, not speed: refusing the 3500 hosts of an ad server list
  at the relay changed the load times of CNN, weather.com, Spiegel, NZZ, Yahoo and 20min by no
  more than their spread, 2026-11-01), no accessibility tree (an engine export), scripts not in workers,
  in already open documents or in `about:blank` frames.
- Core API: console messages of shared workers reach no event.
- Forms: Down in an `<input list>` without an open list does not open it (Chrome does; WebKit
  passes the key only to an open list), and Enter while the list is open without a highlighted
  entry closes it instead of sending the form (like Safari, #403).

## Open: tests and operations

- Firefox (Playwright, xvfb, 2026-11-11 local): in `tests/core/close-while-painting-test.mjs`
  every new view of its page (12 layers of 2400 px with blurred shadows that repaint every 50 ms)
  takes about 33 s, closed or not, the same before and after #514: its first request and the
  deferred chunks its threads need wait that long and the host's console arrives in batches, so
  the host page seems to be blocked. Chromium takes well under 1 s; the test opens only 4 views
  in Firefox. Not analysed yet.
- Real devices 2026-11-03 (BrowserStack): on a Moto G71 one Chrome tab crash during a reload of
  20min.ch (not again in 3 heavy and 5 light reloads; the renderer holds about 0.9 GB with such a
  page). Fast flings on busy pages (20min.ch, bbc.com, spiegel.de on a Pixel 9) left the new
  area empty for 0.5 to 2 s, sometimes the whole view: fixed with tiles painted ahead of a moving
  view (#460; bbc.com on the Pixel 9 with a local build: blank right after four swipes before,
  painted after; images that load late still come later). Samsung Internet on BrowserStack reaches no demo server: a TLS proxy
  of that device's network fails the handshake (an IP address works), not a browser-lite fault.
- weather.com in the CI compatibility job 2026-11-03: two of five runs ended in a crash ("Maximum
  call stack size exceeded" in the engine, in a deep chain of proxies). Deep recursion through
  C++ now gives the page a RangeError (#354), CI green since; its first reserve of 200 KB stopped
  Instagram, Twitch, Walmart and Facebook scripts early, 87 KB since #374 (94 KB in bytes since #500). A one-character `replace` on a
  string built by 100000 appends crashed the engine the same way (Temu's bot check), fixed (#368). Its load event comes after 93 s on
  the CI runners (US) and after 6.8 s from Switzerland (2026-11-03), probably other content there.
- walmart.com showed its error page in about one of three loads (2026-11-11): its webpack runtime
  maps chunk names with 539 nested conditionals, and the parser's recursion for them ran out of
  machine stack when a microtask compiled it; conditional chains now parse without recursion
  (#499: 0 of 6 loads with the error, 2 of 6 before; chains of 5000 and more work, before 575). The same work
  found three engine faults: a literal nested about 600 deep (`[[[...]]]`, `{a:{a:...}}`) kept
  the engine thread busy for good (#499), and the code of a long `===` chain (4518 levels) or a
  second deep `||` chain in the same task crashed it (#500); both give a RangeError now. Still
  open: recursion through C++ (a getter calling a getter, proxies, `toString`, a `sort`
  comparator, a `JSON.parse` reviver) stops after 285 to 560 levels (Chromium 900 to 5800 in
  its own pages): Chromium leaves a worker about 500 KB of machine stack and each such level
  takes about 1.1 KB in eight WASM frames (`callGetter`, `JSC::call`, `executeCall`,
  `vmEntryToJavaScript`, `CLoop::execute` and the slow path). Calling getters and setters from
  the interpreter and the JIT like JS calls would lift it for those; the other paths re-enter
  through C++ in JavaScriptCore itself.
- `damage-test` "changed while hidden" (local, 2026-11-08): in about one of three runs the
  selected text of the input differs in 45 pixels from the reference, with and without damage
  tiles (#454): the selection looks focused in one run and unfocused in the other after the view
  switch, a matter of focus timing, not of damage tracking.
- Firefox CI 2026-11-03: `ui-test` once "Page crashed" at the navigation after the 9 s script
  timeout check (3 of 3 local runs and the rerun clean).
- Firefox 155 (CI job reports without blocking): `compositing-test` CPU painting after a GPU
  loss without the compositor thread (only with `compositing=0`, an expert setting): the engine
  presents the right CPU frame at once (checked in the worker: the scratch canvas has the new
  color), but Firefox shows white until the context is back. Neither the source of the
  `ImageBitmap` (`transferToImageBitmap` of a 2D canvas, `createImageBitmap` of `ImageData`) nor
  the size handling changes that. With the compositor thread (the default) the screen shows the
  CPU frames after a loss; probably because there the worker that lost the WebGL context is not
  the one that presents. Not worked around (#334); `compositing-test` skips this check in Firefox. Now and then in CI (auth, clipboard, background tests)
  an engine worker loaded for about 60 s and then failed: the core's service worker waited in
  `activate` for `clients.claim()`, which waits for the new worker, whose script request waits for
  the activation. Fixed (#301, locally 0 of 8 runs instead of 1 of 5); the engine still logs such
  a worker (`[workers] engine worker did not load after ... ms`), not seen in the 8 CI runs up to
  2026-10-31 nor in 22 Firefox jobs of 11 main runs up to 2026-11-02. Closing or reloading a tab right after a
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
  and in workers the request gives up after 30 s and tries again. 2026-10-30: layer 5 of 8 at step
  0 in phase 13, not 133 or 134: before the layer's flush started, where nothing waits; phase 135
  now marks the call of the flush itself. 2026-10-31: phase 135 for 4 s at layer 6 of 8, step 0:
  the thread stopped between setting the phase and the first statement of
  `CoordinatedPlatformLayer::flushCompositingState` (in engine.wasm, no chunk to load, the step is
  inlined there). Nothing of ours can wait there. In Chromium `devices-test` now records a CPU
  profile of all threads when the engine logs the stall (`build/e2e-devices-stall.trace.json` in
  the artifact `e2e-core-screenshots-chromium`). Not seen in the 14 CI runs since the new touch
  fling and touch scrolling (#313, #314) up to 2026-10-31, which changed the scrolling it always
  followed, nor in 44 end-to-end jobs of 11 main runs up to 2026-11-02.
- The stall log of a view whose compositor never ran (in sweeps a popup of yahoo.com and new
  tabs the host gave no frames) printed the seconds of the monotonic clock as the phase's duration, about
  1.79e9 s; it now counts from the start of the view's scene (#402, `frames-busy-test`).
- Firefox without WebGL: some pages get layers although the view paints without them (#306): no
  longer a crash or a white view, they are painted flattened (the engine logs it). Cause not
  found yet.
- `storage-test.mjs` in Firefox, twice on 2026-10-31: `localStorage` written 400 ms before a crash was
  gone (its 100 ms timer of the engine thread came later); the test waits 1.5 s now.
- `profile-test.mjs` (demo) in Firefox, on 2026-10-31 and 2026-11-01: with the profile server
  unreachable a `localStorage` value written seconds before was gone after the reload (cookies
  and IndexedDB were there); the reruns passed, 0 of 7 local runs (also on one core). Its commit
  log (#302) would only drop it on a base mismatch; the test now lists the device's
  `localstorage` files when it happens.
- `settings-test.mjs` (demo), once on 2026-10-30: right after a restart `getFile()` of an OPFS
  file the page had written before failed with `NotFoundError`, although `getFileHandle()` found
  it (FileSystemStorageWasm.cpp); the next runs passed. `storage-test.mjs` in Chromium on
  2026-11-01, "new profile": the OPFS part of the page failed with `NotFoundError` right after a
  reload (0 of 6 local runs); its result now names the step. `settings-test.mjs` in Chromium on
  2026-11-01 again, after a restart: reading `kept.txt` failed although `getFileHandle()` found it;
  that page now names the step and the message too. WebCore reports any file it cannot
  size or open while reading a `File` as `NotFoundError`, and WasmFS reads through `getFile()`
  of the host's OPFS, which fails while a sync access handle is open on that file.
- reddit.com on an iPhone, once in two runs: `Element.clientWidth` lays out, the post layout tasks
  update the widget positions and lay out a frame again, whose `performLayout` aborts on its
  first release assert (the document is in a render tree update). Not reproduced in Chromium, not
  in 6 runs on an iPhone 16 on 2026-11-01 (3 of them with the JIT and the slabs, scrolling).
- `background-test.mjs` in Firefox with the compositor: the frames per second of a visible view
  vary between CI runs (4, 13, 27, 37, 47; without the compositor about 50), once below the limit.
  Locally (Firefox 155 under Xvfb, 2026-11-02) 39, 56, 59 and 58 with the compositor against 46 to
  59 without, 4 of 4 runs passed: the low values come from the loaded CI runner.
- Flaky under load: `cache-test.mjs` (small quota cleanup), `mediastream-test.mjs` (recording
  sometimes short), in Firefox once a white
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
