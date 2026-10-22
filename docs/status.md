# Status (2026-10-21)

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
  external schemes to the host after a click (#148), context menu data, link hover, fullscreen.
- **Input**: keyboard incl. dead keys and IME preview (#127), clipboard with HTML and files
  (#126), drag and drop (#125), touch, pointer lock, ctrl + wheel to the page first (#167).
- **Rendering**: GPU raster with Skia on WebGL 2, compositing and async scrolling on own threads,
  no frame without a visible change (damage tracking, #220), GPU blur and shadow, CSS Paint
  Worklet, WebGL 1 and 2, recovery after GPU loss.
- **Media**: `<video>`/`<audio>` (also `blob:`, `data:`), MSE, Web Audio, WebCodecs, camera,
  microphone, screen, MediaRecorder, WebRTC (opt-in), Picture-in-Picture, all through the host.
- **WebAssembly of pages** in the host engine, also memory64 and multiple memories (#152, #184).
- **Workers and storage**: service workers with soft update and navigation preload, Cache API,
  OPFS, IndexedDB with limit (#179), cookies and localStorage, all in an OPFS namespace (#142),
  HTTP cache in the host Cache API (#70), partitioned by site like Chrome (#213).
- **Robustness**: watchdog for scripts (#146), crash and hang detection with in-page restart
  (#147, #172), hidden background views (#170), memory pressure near the memory limit found at
  runtime, also in 32 bit browsers with about 1 GB (#171, #216), error pages with the
  relay's reason and auto reload (#174, #175), dead relay detection (#177), fix of a WTF timer
  bug that aborted about 1 % of heavy page loads (#219).
- **Profile on the server**: cookies, localStorage and small IndexedDBs plus app prefs, only the
  last device writes (#188 to #191, #197).
- **Settings**: device emulation with Safari user agents, languages, time zone, color scheme,
  JavaScript, images, Global Privacy Control (#193 to #196).
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

## Open: performance (by value)

1. First paint on heavy sites: usually 0.1 to 0.3 s after first layout (#164), but a long script
   right after it delays the frame. A shorter parser time limit brought nothing without cost
   (#186). To check: with any `?env=` the first paint on YouTube came under 3.5 s in 32 of 36
   runs, without in 10 of 24.
2. Compiling on first call (weather.com about 11 s parser and bytecode), also on repeat visits:
   a persistent bytecode cache hit but brought no measurable gain (#215).
3. Interpreter time (15 to 21 % on JS-heavy sites): only a big rework (tail-call interpreter or a
   JIT to WASM) would help; small caches are done (#143).
4. Forced flex/grid layout from JS (20min about 6.5 s, #141): no cheap fix found.
5. GC 5 to 7 % on JS-heavy sites (#60, #122).
6. Video and animations: frames are painted into the tiles of the view, locally under SwiftShader
   1.8 to 9.7 video frames per second against 25 to 30 in Chromium. A compositor layer for video
   did not help there (#217). Frames without a visible change are skipped since #220 (an
   animation outside the view took all CPU of the device before, now 0.03 CPU seconds per second
   on C); where every frame changes, a frame costs as much as before, and compositing only the
   damage cost more under SwiftShader (CI perf 39644894451 and 39670991733, #220).

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
  SwiftShader, #221), timer queries, queries and
  transform feedback across context switches, WebGPU. Views that lost the GPU while compositing
  stay without layers (new views get them again); a WebGL page that does not draw notices a loss
  only at its next draw.
- Media: EME (DRM), MSE in workers (#121), WebCodecs frames as textures, WebRTC traffic through
  the relay (TURN), insertable streams. A sent track's engine sink stays until `stop()` or until
  its source ends; MediaRecorder errors while fetching data do not reach the page as an event. A
  muted autoplay video briefly reports `pause` and `playing` again right after loading (Chrome
  does not).
- Service workers: Push, Background Sync, Background Fetch.
- Network: HTTP authentication (401 with Basic/Digest) has no login dialog, the page shows the
  body of the 401 response; WebTransport, streams as request body, Storage Buckets,
  WebSocketStream without read backpressure (#120).
- Storage: localStorage reaches SQLite 1 s after a change and can miss the last change on close;
  with `/data` in memory (second tab) uploads sit in WASM memory. WebKit's memory cache is shared
  by all views of a running engine, only the HTTP cache is partitioned (#213).
- Measurement: layout shift and long animation frame entries, IdleDetector,
  `document.featurePolicy`.
- UI: drag and drop outside a drop target opens nothing (#125; Chrome loads the link or file in
  the same tab, deliberately not here because an accidental drop would replace the page).
- Devices and identity: WebAuthn, Credential Management, Payment Request, Web MIDI/USB/HID/Serial,
  WebXR.
- Core API: no event for console messages without a view (service workers), no warning for
  skipped uploads (larger than 512 MB), no way to re-arm the watchdog after "wait".
- The test hooks `gpu()` are not gated by `BL_TEST_HOOKS` in the engine (only the host can call
  them).

## Open: tests and operations

- `soak-test.mjs`: the host page hangs after 200 navigations in about every second run (looks
  like a main thread futex spin). Run browser tests with `ulimit -c 0`.
- Flaky under load: `cache-test.mjs` (small quota cleanup), `mediastream-test.mjs` (recording
  sometimes short), the memory check of `wasm-test.mjs`, "animation runs while JS blocks" in
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
- **Async dialogs**: the `dialog` handler is synchronous (the engine thread waits); an async
  variant would allow custom in-page dialogs.
- **Navigation policy**: a host hook to allow, block or redirect navigations of the pages.
- **Engine from a CDN**: a same-origin worker trampoline so the large files can come from another
  origin.
- **Fonts**: more scripts and emoji in `engine.data`, or loading fonts on demand.
- **WireGuard**: `WireGuardTransport` (user space TCP/IP and WireGuard in WASM, UDP over Wisp), so
  sites see another network than the relay's datacenter IP.
- **Firefox and Safari**: from best effort to supported.
