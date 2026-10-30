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
one task shortly after loading (its scripts in the interpreter); meanwhile the page does not
react. In Firefox without WebGL the view is white for a few seconds around such long tasks,
although Firefox shows a worker's canvas frames at once (checked with a plain OffscreenCanvas);
cause open.

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
