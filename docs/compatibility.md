# Compatibility with real sites

The site list is `tests/compat/sites.txt`. CI loads it in the job `compat` (informational, foreign
servers fail now and then) and writes a table into the run summary. Screenshots are in the
artifact `compat`, named by host and path (`build/sites/<host>_<path>.png`).

## State 2026-10-30 (local)

40 further sites (Google Maps, Office, Outlook, DeepL, ChatGPT, Notion, Stripe, Airbnb, Etsy,
AliExpress, IKEA, Swiss shops and services, news, Codepen, Excalidraw, Photopea, Canva, learning
sites, GeoGebra, Desmos) load without a crash. Only here: `cookieStore` failed on every call
(Airbnb, Notion's consent manager; implemented since #304), IKEA's report-only CSP reports its
scripts (only console lines), Outlook's duplicate `let` (native Chromium has it too).
Cloudflare's challenge (Turnstile, on Moodle, Quora, Codepen from this host) passes, the
checkbox comes after about 25 s instead of about 10 s in native Chromium (its first attempt fails
inside the obfuscated script and repeats). Etsy, Coop, Reuters and AliExpress block this host's
address in native Chromium too. codepen.io scrolled faster than the engine painted its animated
background: the unpainted area showed white for seconds (now the page's background, #305).
The same 40 sites with Firefox as host (headless, without WebGL, so without compositing): codepen.io,
airbnb.com and soundcloud.com ended the engine (#306, now painted flattened); the rest looks like
in Chromium. chatgpt.com keeps the engine thread busy for 15 s (Chromium) to 21 s (Firefox) in
one task shortly after loading: a timer's async function, 12 of 20 s in the interpreter loop
itself with `charCodeAt` and bit operations on top (hashing, likely its proof of work); only a
faster interpreter or a JIT would help (status.md, performance). Meanwhile the page does not
react. In Firefox without WebGL the view is white for a few seconds around such long tasks,
although Firefox shows a worker's canvas frames at once (checked with a plain OffscreenCanvas);
cause open.

A third sweep (40 sites: Swiss news, real estate, universities, design and productivity tools,
shops, travel, sports, developer docs, news) found espn.com without any frame with the compositor
and the engine ending on an iPhone (backdrop filters, #308; since then it renders on both, and
open.spotify.com, rts.ch and npr.org, which stayed blank, too). fifa.com needs about 40 s until
its page shows (many scripts in the interpreter). Site errors that native Chromium
shows too (uzh.ch `$`, homegate.ch, Kickstarter's Apollo warnings) and bot checks (homegate,
TripAdvisor, Yelp, zeit.de, Expedia) aside, the rest renders.

All three lists (134 addresses) with Firefox as host and WebGL (Xvfb, like CI), engine of
0d48c8a: no crash, the pages look like in Chromium apart from bot checks and pages still loading
after 10 s (fifa.com, expedia.com).

iPhone (iOS 18, BrowserStack, engine of 0d48c8a): Wikipedia, YouTube, Google, amazon.de,
srf.ch, GitHub, Airbnb, ChatGPT and Spotify load without a crash; reddit.com ended the engine
once in two runs (status.md). The same ten on an Android phone (Chrome): all load without a crash
and look right (Spotify asks for its app on mobile). Interactive on both phones (engine of
4f3ad4d): a Google search (tap into the field, type, Enter; before #309 the tap opened a
suggestion), a Wikipedia search, filling GitHub's sign-in form (also the password field), a
YouTube video that plays with sound after a tap; on the iPhone also swiping with momentum, a cookie
dialog and a link on srf.ch, and tabs (new tab, address, switching back). Form controls on the
iPhone: checkbox, `<select>` (our list), a date field through Safari's calendar (#310, #311: tap
the field, then the input in the sheet, pick a day). On Android the tap on a date field opens
Chrome's date dialog through `showPicker()` (it consumes the activation of the tap; the driver's
screenshots do not show native dialogs). A file input on the iPhone opens Safari's chooser (photo
library, camera, files) through the sheet of #312. Also on Android: a DuckDuckGo search, swiping
on Wikipedia (before #313 one short swipe of the driver flung over 4000 px) and tabs; on the iPhone
sbb.ch's timetable form (consent, typing into From and To with the suggestions above the keyboard,
the location prompt of "Current location"). On an iPad (Safari reports a Mac) the date field's
sheet appears as well and opens Safari's calendar popover. Google Maps on the iPhone: the app
promo, panning; until #314 a swipe that began on its bottom sheet zoomed the map out (the page got
wheel events). An Amazon search on Android (cookie sheet, search, results). openstreetmap.org
(Leaflet, pointer events) pans under a finger on both phones since #316. A scroll-snap carousel
on Android: a short drag goes back to its item since #319 (before, every move went to the next).

## State 2026-10-29 (local)

All 54 sites load without a crash in Chromium and in Firefox (screenshots after 10 s look like
Chrome; after the default 1.5 s some are still empty). Page errors after loading and scrolling,
compared with native Chromium with the same user agent: nearly all also happen there. Only here:
amazon.de's login code expected `PublicKeyCredential` (now there without an authenticator,
#298), a host error on discord.com (stale memory view, #297), Twitch's bot check (below), a
reCAPTCHA load timeout on reddit.com and an `Error` without a message on paypal.com.
Real input (Chromium and Firefox as host): search, forms with umlauts, text selection, double
click, `<select>` by keyboard, `contenteditable`, dragging Google Maps, a download by link and
keyboard scrolling (PageUp/PageDown/Home/End since #300) work. Vimeo's player (hls.js) stops
loading right after setting the duration, without adding a SourceBuffer; the same happens in
headless Chromium itself with any user agent, while fragmented MP4 (H.264) through MSE plays in
the engine.

## State 2026-10-16 (local)

All 54 sites load without a crash (eBay shows its block page). Tested through a local relay,
screenshot shortly after load. "ok" means: loads, no crash, the screenshot looks like Chrome
(apart from parts still loading). Many sites show their cookie dialog first because the test
starts without stored data.

| Site | Status | Note |
|---|---|---|
| Google Search, Google Maps, Google Translate | ok | Google's consent page first. Maps draws with WebGL |
| YouTube | ok | Consent page first; the start page without login is empty, like in Chrome |
| Wikipedia, Bing, DuckDuckGo, Yahoo | ok | |
| X, Instagram, Facebook, LinkedIn | ok | Login pages |
| Reddit, old.reddit | ok | Reddit runs a JavaScript check first |
| TikTok | ok | Video plays |
| Twitch | partly | Loads; the featured stream of the front page does not start: the player loads segments but never attaches media to its `<video>` (YouTube plays through MSE), and Twitch's bot check script (Kasada `ips.js`) throws only here (2026-10-29). Its player (Amazon IVS, in a worker) loads the segments, then its worker sends `pause` and the page never calls `play()` or MSE, also after a click; Chromium with the same user agent plays muted (also with MSE in workers hidden). Visibility, focus and the codec answers are the same; the cause is open |
| Discord, Netflix, PayPal | ok | |
| Spotify Web Player | ok | Takes longer until content |
| GitHub, Stack Overflow, MDN, W3Schools, Python docs, Hacker News | ok | |
| npm, Medium | ok | Cloudflare may show "Verify you are human" for datacenter IPs; the check gets there with WebAssembly |
| Apple, Microsoft, Amazon | ok | |
| eBay | blocked | "Something went wrong on our end": eBay blocks datacenter IPs. Caused by the relay's IP, not the engine |
| CNN, BBC, NYTimes, Spiegel, SRF | ok | |
| weather.com | ok | Much JavaScript, the slowest of all |
| 20min, Blick, NZZ, Galaxus, Zalando, Ricardo | ok | |
| Booking, IMDb, SBB | ok | The AWS WAF bot check computes through (WebCrypto with OpenSSL 3, patch 0010) |
| OpenStreetMap | ok | Map |
| three.js example (WebGL), Squoosh | ok | |
| sql.js demo (SQLite as WebAssembly in a worker) | ok | Query gives the right result |

## Yardstick against Chromium

`tests/core/parity-test.mjs` loads `tests/fixtures/features.html` (280 checks) in the host Chromium
and in browser-lite. State 2026-10-16: **257 of 280 like Chromium (91.8 %)**. Missing:

- Not in WebKit: layout shift and long animation frame entries, `interpolate-size`, streams as
  request body, Storage Buckets, Background Sync, `document.featurePolicy`, IdleDetector.
- Needs own network or engine work: WebTransport (QUIC through the relay), JSPI, MSE in workers
  (#121 in [decisions.md](decisions.md)).
- WebAuthn without an authenticator (#298): `PublicKeyCredential` and `navigator.credentials`
  exist, no passkeys, `create()`/`get()` refuse.
- Open without a decision ([status.md](status.md)): password credentials, Payment Request, Web MIDI/USB/HID/Serial, WebXR, EME, WebGPU, Push. Left out on purpose: only
  `userAgentData` (#90).

browser-lite already has `Math.sumPrecise`, Temporal and `ReadableStream.from`, which the host
Chromium lacks. The list of differences is in the CI run.

## Known limits

- Some sites block datacenter IPs (eBay; Cloudflare shows a checkbox). A relay in a datacenter and
  the CI runners have such an IP.
- JavaScript is slower without JIT (C loop); big sites take 10 to 60 s.
- WebAssembly with shared memory (threads) and JSPI do not work; `validate()` returns false for
  such modules and sites usually take a variant without threads or with Asyncify. memory64 and
  multiple memories work; a memory has at most 2 GB, JS and WebAssembly calls nest at most 64 deep.
- CSS Paint Worklet: the script is evaluated classically, modules with `import`/`export` reject
  with `AbortError`.
- No DRM (EME): Netflix and similar services play no protected video.
