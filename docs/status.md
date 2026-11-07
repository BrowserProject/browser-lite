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
  stayed empty, the interpreter cached a missing `meta` export for all modules, #431).
- **Browsing**: views with popups (opener, name, sandbox; without a user gesture blocked with an
  icon in the demo that opens them or allows the site, #384), history incl. back/forward cache
  (address and title of the restored page, #367), favicons for every loaded page (also after a
  page without one or back to a page whose next page never loaded, #389),
  downloads (a link or form whose answer becomes a download asks the server once, #412), uploads,
  find, zoom (per site in the demo, #385), pinch zoom on the compositor (#150),
  a tab discarded under memory pressure, reopened (Ctrl+Shift+T) or from the last session back
  at the scroll position of its page like Chrome (#440),
  print to PDF, view source,
  external schemes to the host after a click (#148), context menu data, link hover, fullscreen,
  HTTP authentication with Basic and Digest and a sign-in dialog like Chrome's (#257),
  validation messages and the file input's label with their numbers and texts (#363), a typed
  `data:` or `about:` address without the Content-Security-Policy of the page before (#408),
  an address typed without a scheme over `https://` with a fallback to `http://` when the site
  has no working `https://`, and localhost, IP addresses and ports over `http://` like Chrome
  (httpforever.com, 127.0.0.1:7650 and localhost:7650 ended on ERR_SSL_PROTOCOL_ERROR, #435).
- **Input**: keyboard incl. dead keys and IME preview (#127), Backspace and suggestions of
  Android keyboards after typing (#411), clipboard with HTML and files
  (#126), drag and drop (#125), touch with pointer events (#316), swiping along `touch-action`
  without wheel events (#314) with scroll snapping and the engine's fling (#319), pointer lock, ctrl + wheel to the page first (#167), keys to the page before the browser's shortcuts like Chrome (an editor's own Ctrl+F, Ctrl+P, Ctrl+L, Ctrl+U underline, #436), Escape stops a loading page like Chrome's Stop when neither the page nor a field of the demo takes it (#437),
  `buttons` and `pressure` of mouse and pointer events, also with chorded buttons (#370),
  Tab to links (#372), mouse leave of the view (`:hover` and link address go away, #381),
  mouseout and mouseleave on the first move after back or forward to a cached page (#398),
  taps under the overlay scrollbars at the right edge on phones (#413), no hover and mouseover from a
  scroll after a tap (#426).
  Input runs before the engine's queued work (#347), waiting mouse moves coalesce (#350), the
  parser yields after 50 ms (#349): on 20min.ch locally the 90th percentile of input latency
  during the load went from 3.5 to 0.8 s; a Moto G71 before the change: median 6 s, up to 23 s.
  Hidden views wait while the user types or taps in a visible one (#364), through the pauses of a
  writer while the focus stays in a text field and while a visible view loads a new page until it
  commits (#394): with weather.com loading in a background tab, typing in bursts with 2.5 s pauses
  went from median 0.42 s (90th percentile 1.1 s, up to 7.5 s) to 2 ms (frame 32 ms), a new tab
  next to two loading heavy tabs commits in 0.3 to 2 s instead of 11 to 17 s. After a pause of
  more than 10 s (or 1 s outside a text field) a key can still wait for a task that already runs.
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
  (#371) and close when the page removes the field or navigates (#424). The suggestions of `<input list>` show below the field like Chrome's dropdown, with
  Up, Down, Enter and Escape in the field (#403).
- **Rendering**: GPU raster with Skia on WebGL 2, compositing and async scrolling on own threads
  (smooth scrolls a page starts, such as `scrollTo` with `behavior: 'smooth'`, run without input, #366),
  no frame without a visible change (damage tracking, #220), the first paint right after the first visible layout, before
  waiting scripts (#246), frames between the tasks of a busy page (#359: 40 tasks of 100 ms got
  33 to 36 frames instead of 7 or 8), GPU blur and shadow, CSS Paint
  Worklet, WebGL 1 and 2, recovery after GPU loss. After a rotation or an on-screen keyboard the
  last frame stays unscaled until the page painted the new size (#404; before, it was stretched
  or squashed for seconds on heavy pages), and fractional pixel ratios stay sharp in Firefox and
  WebKit. Pages taller than 2^24 px show their content to the bottom (#409; before, all
  below about 16.7 million px was blank). A filtered layer keeps the text shadow of its contents
  (#442; zoo.ch had hard dark boxes behind its headline with `filter: blur(0px)`).
  AVIF images decode (libavif with dav1d, also 10 bit, alpha and animated, #447): the engine sends
  Safari's user agent, so AliExpress sent its product pictures as AVIF, which showed as broken
  icons. A 1600 x 1067 picture decodes in about the time of the same WebP (46 against 47 ms,
  JPEG 30 ms, locally). Sites of the hot functions profile now send AVIF too (Accept), so the
  decoder's common paths are in `engine.wasm`: 90 KB more gzip for the start, 230 KB deferred.
- **Media**: `<video>`/`<audio>` (also `blob:`, `data:`), MSE, Web Audio, WebCodecs, camera,
  microphone, screen, MediaRecorder, WebRTC (opt-in), Picture-in-Picture, all through the host.
  Muted autoplay plays only in the view like Chrome: 20min.ch idles at 5 % CPU instead of 25 to
  29 % with its teasers below the fold (plain Chromium 6 to 7 %, #399). Transparent videos (VP8,
  VP9, HEVC with alpha) keep their alpha when frames are copied (#442; the filtered hero video of
  zoo.ch covered the photo with opaque green).
- **WebAssembly of pages** in the host engine, also memory64 and multiple memories (#152, #184).
- **Workers and storage**: service workers with soft update and navigation preload, Cache API,
  OPFS, IndexedDB with limit (#179), cookies and localStorage, all in an OPFS namespace (#142),
  HTTP cache in the host Cache API (#70), partitioned by site like Chrome (#213), with ranges
  (206, media pieces) like Chrome's sparse entries (#222).
- **Robustness**: watchdog for scripts (#146), crash and hang detection with in-page restart
  (#147, #172), hidden background views (#170), memory pressure near the memory limit found at
  runtime, also in 32 bit browsers with about 1 GB (#171, #216), from 512 MB on iPhone and
  iPad (#358), error pages with the
  relay's reason and auto reload (#174, #175), also for a missing `file:` and an unknown
  `about:` address (#395) and for a restricted port or the address 0.0.0.0, typed or as a
  redirect target, where the view stayed blank before (#400), and for a redirect loop (more
  than 20 redirects) or a redirect to `file:` (#406), and like Chrome for an HTTP error status
  without a body (`HTTP ERROR 500`, before a blank page, #425), the error page as the only
  message: the demo no longer repeats it with curl's text in the status line or the phone
  layout's snackbar (#427), a request whose pooled connection dies before any response byte
  goes again on a new connection like in Chrome (#397), the relay connects with Happy Eyeballs
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
  runs), a loop of 6 s full of garbage keeps the 256 MB it started with (before 369 MB).
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
  restores it with Escape, keeps an address that is still loading (a slow server, a sign in prompt) in the bar and the tab until its page commits (#382), searches for an invalid address like `http://example.com:99999/` like Chrome instead of loading a mangled one (#407), a find bar that Escape closes also after a click on its buttons (#376), one find bar per tab that a navigation closes (#390), Open link or image in new tab of the context menu in the background like Chrome (#391), Ctrl+Shift+T for the tab closed last (#377), tabs reordered by dragging with the mouse and Ctrl+Shift+PageUp/PageDown (#383), closing the active tab activates the tab it was opened from or its right neighbour like Chrome and Firefox (#410), tabs opened from links right after their page in the order of the clicks and Ctrl/middle click on a `target=_blank` link in the background like Chrome (#416), Shift+click and Ctrl+Shift+click on a link in front directly after its page (Chrome opens a window for Shift+click; #438), a middle click on a tab closes it like Chrome and Firefox (#418), inline completion of visited sites, Ctrl+Enter for `www.<name>.com` and Alt+Enter for a new tab in the address bar like Chrome (#420), an unfinished address bar edit per tab across tab switches, Escape back to the typed text after an arrow key choice and the page address after a `javascript:` address (#439), the address and the find text after Safari's Back and Forward to the demo (page cache, #422), suggestions with a search row and site icons, the menu as a dropdown,
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
  (#414).
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
  all jobs on GitHub-hosted runners, the deploy logs in to the public server over SSH with a key
  of its own, Caddy serves HTTPS and HTTP/3 in front (#335).

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
   Long single tasks of a page become many times longer here, so they block all views and can
   reach the script watchdog (#146). Cloudflare Turnstile on kaufland.de (2026-11-05, local,
   Chromium host): the challenge iframe blocks the engine thread in single entries of 10 to 30 s
   (about 90 s within 2 minutes), the one that reaches 30 s is terminated and the widget stays at
   "Verifying". Plain Chromium with a desktop user agent on the same machine: the challenge's
   renderer is busy 3.2 s, its longest tasks take 0.8, 0.55 and 0.34 s, so about 35x faster. The
   profile of a block has no single cause: about half compiled code, 15 % interpreter and its
   slow paths, the rest JS runtime (arrays, `apply` with spread arguments, `Reflect.construct`,
   bound functions), WebGL fingerprinting 3 %, ICU data loaded lazily 3 %, forced layout 2.5 %.
   With `?scripttimeout=600` the challenge passes after about 40 s of blocks. Only faster JS
   fixes it ([jit.md](jit.md)). Its garbage no longer stays (#448), but while the challenge runs
   malloc's use still rises by about 3 MB/s with a JS heap of about 25 MB (2026-11-07, not
   found yet). Not done either: the demo's "Wait" after `unresponsive` does not
   move the watchdog's deadline, so waiting cannot save such a script. LinkedIn Learning
   (2026-11-06, the PerimeterX bot script `client.protechts.net/.../main.min.js`, which plain
   Chromium also loads, its main thread 10 % busy): after the load the engine thread answers no
   eval for up to 10 s, about 35 s in all, then recovers. Its hashing loops (bit operations on
   uint32 values, typed arrays, `Math.imul`) fell to slow paths: they now run inline and such
   loops 2 to 5 times faster (#424), but the block stayed as long. Its profile is the script's
   obfuscated VM calling small functions: the C++ path of calls from compiled code 15 % of the
   engine thread (self time), entries through the interpreter 8 %, compiled code half. Cheaper
   calls (in WASM, values in locals, phase 4 of [jit.md](jit.md)) are what is left.
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
   (#405): no cheap fix found. On 20min.ch (2026-11-05, local, idle machine) a resize keeps the
   page's thread busy about 1 s in 3 to 4 tasks (the largest 0.55 to 0.95 s, the first frame
   after 40 to 50 ms), native WebKit (Playwright) 0.5 s, Chromium 0.1 s. One forced relayout
   costs 65 to 70 ms here, 43 to 50 ms in native WebKit and 3 ms in Chromium: WASM adds 1.5 to
   2x, the rest is WebKit's layout. The content column there is a stretched flex item (a row
   flex in a column flex) with 294 `height: 100%` descendants. WebKit lays such an item out once
   without and once with its final size, and every layout of a block dirties all of its
   percentage height descendants (`RenderBlockFlow::layoutBlock`,
   `RenderFlexibleBox::flexItemHasPercentHeightDescendants`, FIXME webkit.org/b/204318), so
   each pass lays the whole content out four times, grids inside again for their row sizes.
   Without the stretch, the column flex and the percentages one relayout costs 11 ms in native
   WebKit. Even a 3 px wider leaf in the header lays the whole content out (native WebKit 35 ms,
   Chromium 0.1 ms), which is why the forced layouts while loading cost that much. Chromium
   caches layout results per constraint; in WebKit that is a rework of block, flex and grid
   layout. The blocks of 2 s and more first reported came from a machine with a load of 55 to
   72 on 10 cores. A window drag is coalesced: 3 resize events for 20 steps (native WebKit 20).
4. GC 5 to 7 % on JS-heavy sites (#60, #122).
5. Video and animations: with compositing Chromium shows the video itself behind the view canvas
   (#232); videos with opacity, blend modes, filters or 3D transforms keep frames painted into the
   tiles of the view, locally under SwiftShader 1.8 to 9.7 video frames per second against 25 to
   30 in Chromium (#217). Frames without a visible change are skipped since #220 (an
   animation outside the view took all CPU of the device before, now 0.03 CPU seconds per second
   on C); where every frame changes, a frame costs as much as before, and compositing only the
   damage cost more under SwiftShader (CI perf 39644894451 and 39670991733, #220).
   A small visible animation therefore costs a whole view per frame, and the cost follows the
   view's area, not the change (2026-11-05, local, Chromium headless with SwiftShader): one
   44 px CSS spinner keeps the GPU process at about 2 cores, 60 frames per second at 640x480,
   13 at 1920x1080 (165 ms of GPU process CPU per frame); Chromium itself shows it with 7 %
   CPU. On weather.com 46 pulsing skeleton boxes kept 4 cores busy after the load event. Most
   of it is the host showing a new view sized canvas, which no engine side change avoids.
   Measured in plain Chromium at 1920x1080, GPU process CPU per frame: a WebGL frame that is
   only cleared and shown with `transferToImageBitmap` 94 to 105 ms; the same with
   `preserveDrawingBuffer` and only a 52 px square drawn (compositing just the damage into a
   kept framebuffer) 117 to 119 ms; a whole view textured quad 181 to 183 ms; even Chromium's
   own 2D canvas in the page with a 52 px `fillRect` per frame 49 ms; a separate 64 px canvas
   element 1.9 ms. So compositing only the damage would gain at most about a third on frames
   with a small change and cost a copy of the view on every other frame (scrolling), as #220
   found. Cheap small animations need the host browser to composite them: layers with running
   animations as their own host elements, moved by the host's compositor. That is a new
   compositor architecture, not done; on devices with a real GPU a whole view frame costs far
   less (not measured).

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

## Open: features

- Typed addresses (#435): the engine commits its error page of the failed `https://` load before
  the core falls back to `http://`, so the page shows for a moment and the failed address stays in
  back/forward before the `http://` page (Chrome keeps one entry). Falling back in the engine's
  `dispatchDidFailProvisionalLoad` instead of showing the error page would avoid both. No
  fallback timer: a host that drops connections to port 443 falls back only after the connection
  timeout.
- Touch selection: a long press selects the word, but there are no selection handles to extend
  it like Chrome and Safari on phones (needs the selection bounds from the engine and commands
  that move either end).
- `timeZone` applies only at `createBrowser`; the demo restarts the engine for a changed device
  too, although `Browser.setDevice()` could apply it (it uses that only for the rotation, #336).
- Pinch zoom: `visualViewport` events only at the end of the gesture; two fingers wait for the
  page's touchstart answer even without blocking listeners.
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
  has no budget yet (no kill seen so far). With no background tab left to discard the demo says
  that the page uses the memory (#373), again at every growth by 32 MB.
  News sites with their ads reach the budget with two tabs (#417): on an iPhone 16 with the
  shared profile (consent given, so all ads load) nzz.ch alone holds 331 MB of malloc in use (JS
  heap 59 MB), The Guardian 267 MB after releasing everything, so nzz.ch plus one more page
  passes 512 MB with the area about as full as it is big (no leak, no fragmentation worth
  speaking of). Without the budget the engine froze silently at 775 MB of engine memory after
  three such tabs (2026-11-06; earlier iOS ended the page at 1.15 and 1.36 GB, and a freeze on
  spiegel.de at 1.1 GB on 2026-11-03), so the budget stays. Lower only with lighter pages: most
  of the malloc in use is many small blocks of DOM, style and JS of the page and its ad frames,
  JS heap slabs and decoded images; tile buffers waiting for the compositor add up to 20 MB at a
  phone size while a page paints. After a crash the restart on an iPhone failed twice with
  `Engine start failed: RangeError: Out of memory` until Safari was restarted.
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
  the same tab, deliberately not here because an accidental drop would replace the page).
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

- Real devices 2026-11-03 (BrowserStack): on a Moto G71 one Chrome tab crash during a reload of
  20min.ch (not again in 3 heavy and 5 light reloads; the renderer holds about 0.9 GB with such a
  page); after three fast flings in a row on 20min.ch (Pixel 9) the new area stays empty for 1 to
  2 s until the busy engine records its tiles (one fling is painted at once; tiles cover half a
  viewport above and below). Samsung Internet on BrowserStack reaches no demo server: a TLS proxy
  of that device's network fails the handshake (an IP address works), not a browser-lite fault.
- Phone UI, seen on devices 2026-11-03: the bottom bar stays in landscape (44 px since #356; the
  page kept 221 of 303 px on a Pixel 9 with the old 58 px bar; hiding it while scrolling needs a
  scroll event of the page and a viewport that does not lay out again).
- weather.com in the CI compatibility job 2026-11-03: two of five runs ended in a crash ("Maximum
  call stack size exceeded" in the engine, in a deep chain of proxies). Deep recursion through
  C++ now gives the page a RangeError (#354), CI green since; its first reserve of 200 KB stopped
  Instagram, Twitch, Walmart and Facebook scripts early, 87 KB since #374. A one-character `replace` on a
  string built by 100000 appends crashed the engine the same way (Temu's bot check), fixed (#368). Its load event comes after 93 s on
  the CI runners (US) and after 6.8 s from Switzerland (2026-11-03), probably other content there.
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
