# Compatibility with real sites

The site list is `tests/e2e/sites.txt`. CI loads it in the job `compat` (informational, foreign
servers fail now and then) and writes a table into the run summary. Screenshots are in the
artifact `compat`, named by host and path (`build/sites/<host>_<path>.png`).

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
| Twitch, Discord, Netflix, PayPal | ok | |
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

`tests/e2e/parity-test.mjs` loads `tests/engine/features.html` (280 checks) in the host Chromium
and in browser-lite. State 2026-10-16: **257 of 280 like Chromium (91.8 %)**. Missing:

- Not in WebKit: layout shift and long animation frame entries, `interpolate-size`, streams as
  request body, Storage Buckets, Background Sync, `document.featurePolicy`, IdleDetector.
- Needs own network or engine work: WebTransport (QUIC through the relay), JSPI, MSE in workers
  (#121 in [decisions.md](decisions.md)).
- Open without a decision ([status.md](status.md)): WebAuthn, Credential Management, Payment
  Request, Web MIDI/USB/HID/Serial, WebXR, EME, WebGPU, Push. Left out on purpose: only
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
