# Embedding browser-lite

What a site needs to run browser-lite: a cross-origin isolated page, the engine files on the same
origin, a relay, and optionally a service worker for media. Complete, tested setups are in
[examples/](../examples/README.md): [examples/minimal/](../examples/minimal/README.md) (own route,
Vite, one view) and [examples/existing-site/](../examples/existing-site/README.md) (existing site
with `node:http`, the server package, its own service worker and a strict CSP). API details are
in the package READMEs ([core](../packages/core/README.md),
[transport-wisp](../packages/transport-wisp/README.md), [ui](../packages/ui/README.md),
[profile](../packages/profile/README.md), [server](../packages/server/README.md)); threats and a production checklist in
[security.md](security.md).

## Embedding modes

The engine uses pthreads, which need `SharedArrayBuffer`, which needs a cross-origin isolated
page (`crossOriginIsolated === true`).

| Mode | When | Notes |
|---|---|---|
| Own route or subdomain | Recommended (a subdomain in production, [security.md](security.md)) | Serve one route (for example `/browser/`) or a subdomain with the headers below; the rest of the site stays unchanged. A subdomain also gives the browser its own storage origin; with a route, the browser's stored data (OPFS, caches) is readable by every page of the origin |
| Inside an existing page | The page is cross-origin isolated already, or can become so | Every subresource must be same-origin or allow embedding (CORP or CORS). `Cross-Origin-Embedder-Policy: credentialless` instead of `require-corp` relaxes this for third-party resources in Chromium and Firefox |
| In an iframe | Only inside a cross-origin isolated top-level page | A frame is isolated only if its parent is: the top-level page and the frame both send COOP/COEP. The iframe delegates the features the services use (see below) |
| `Document-Isolation-Policy` | To evaluate | Chromium-only header that isolates a single document without COOP/COEP on the top-level page; not tested with browser-lite yet |

The `allow` list of the iframe, as tested in [examples/existing-site/](../examples/existing-site/README.md)
(drop what you do not enable):

```
cross-origin-isolated; fullscreen; autoplay; picture-in-picture; clipboard-read; clipboard-write;
camera; microphone; display-capture; geolocation; gamepad; accelerometer; gyroscope; magnetometer;
keyboard-map
```

A same-origin frame has most of these by default. A cross-origin frame (for example on a
subdomain) needs all of them, and its documents and resources need
`Cross-Origin-Resource-Policy: cross-origin` or `same-site`. In Chromium a cross-origin frame
also cannot show File System Access pickers or ask for notification permission (platform rule,
not tested).

COOP `same-origin` puts the page into its own browsing context group: `window.opener` between the
browser page and other pages of the site is cut. `checkSupport()` reports what is missing, and
`createBrowser` throws `not-cross-origin-isolated` or `unsupported`.

## Headers

| Response | Headers |
|---|---|
| The page with the browser, and in an iframe setup the top-level page | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` |
| Worker and worklet scripts (`engine.js`, `sw.js`, `media-sw.js`, `audio-worklet.js`, `opfs-writer.js`) | Same as the page |
| Every subresource of the page | Same-origin, or `Cross-Origin-Resource-Policy` (`cross-origin` for shared CDNs) or CORS |

The simplest rule: send COOP, COEP and CORP with every response of the browser route. That is
what `coiHeaders()` and `serveStatic()` of `@browser-lite/server/static` do. If the site's own
service worker answers navigations from a cache, the cached HTML responses must keep their COOP
and COEP headers, and synthesized subresource responses need CORP; otherwise the page loses
isolation.

## Serving the engine

- The engine folder (`engine.js`, `engine.wasm`, `engine.deferred-<n>.wasm`, `engine.data`, `lazy/`)
  must be **same-origin** with the page: the engine starts its workers from `engine.js`. `createBrowser` rejects a cross-origin
  `engineUrl`. A CDN works only behind the same origin (reverse proxy).
- Never bundle `engine.js`: the core loads it as a classic script at runtime. Copy the folder as
  it is. `audio-worklet.js` (export `@browser-lite/core/audio-worklet.js`) must stay a file next
  to the core's `dist/` code (Vite: keep `.js` assets out of `assetsInlineLimit`). The same for
  the module worker `opfs-writer.js` of `@browser-lite/profile` (only started where
  `createWritable` is missing, Safari 18), which bundlers that know `new Worker(new URL(...,
  import.meta.url))` (Vite, webpack) emit by themselves.
- Put each engine version in its own folder (for example `engine/<hash>/`, as
  `tools/package-demo.sh` does) and cache it `public, max-age=31536000, immutable`.
- After an update Chrome can load the new engine as deltas against the old one (Compression
  Dictionary Transport, #244): `browser-lite-server` marks the engine files as dictionaries and
  sends the `.dcz` files of `tools/engine-deltas.mjs` (`tools/package-demo.sh <engine> <out>
  <previous>`), about 1 MB instead of 9.4 MB for `engine.wasm`. Keep the previous engine folder
  for a while, open tabs still load chunks and `lazy/` files from it.
- `engine.wasm` and the chunks `engine.deferred-<n>.wasm` as `application/wasm` (streaming compilation),
  precompressed. Sizes of a
  packaged engine (name section stripped):

| File | Raw | Brotli |
|---|---|---|
| `engine.wasm` (what the start and common pages run) | about 47 MB | about 9.4 MB |
| `engine.deferred-<n>.wasm` (21 chunks of the rest, loaded after the start, #238) | about 27 MB | about 5.6 MB |
| `engine.data` (Noto Sans, CA bundle, fontconfig, HRTF data) | about 2.7 MB | about 0.6 MB |
| `engine.js` | about 0.3 MB | about 0.06 MB |
| `lazy/icu/` (ICU data beyond the linked core, 2585 files, loaded on first use) | about 17 MB | about 6 MB |
| `lazy/fonts/` (Noto Serif, Mono, italics, scripts, symbols, CJK and emoji slices, 611 files, loaded on first use) | about 26 MB | |

A first visit transfers about 10 MB with Brotli before the engine starts and 5.6 MB more in the
background; a page that needs code of a chunk before it arrived waits for that chunk (#238). Later visits come from the HTTP cache and Chrome's code cache (about 16 MB
of compiled engine code from the second start on). `createBrowser` requests the three files at
once, one request each, while the storage lock and `storage.beforeStart` run (the engine compiles,
instantiates and loads its workers meanwhile, only its `main()` waits for them); `engine.wasm`
compiles while it downloads (#218 in [decisions.md](decisions.md)), the chunks are requested
one after the other once it is there. Preload hints in the page start two of them with the HTML instead
of after your script (the demo injects them in `apps/demo/vite.config.ts`, two round trips
earlier):

```html
<link rel="preload" href="/engine/0.1.0/engine.data" as="fetch" crossorigin>
<link rel="preload" href="/engine/0.1.0/engine.js" as="script">
```

Do not preload `engine.wasm`: Chromium gives a `fetch()` that takes a preloaded response no code
cache, so every start compiles the engine again (#237, `tests/demo/code-cache-test.mjs`).

On a slow network the first visit takes a while (about 25 s until the engine runs at 5 Mbit/s
and 150 ms, `tests/bench/slow-start.mjs`): show the `onProgress` of `createBrowser` (#226). It counts only a download, because
counting a copy of the body costs 0.1 to 0.2 s also when the files come from the cache; the
files count as cached when `engine.js` came from the cache.

## Content Security Policy

A policy for the browser page with the relay on the same origin, verified in Chromium with no
violations (page rendering, the ui context menu, a video through the service worker, Media Source
Extensions, Web Audio) by [examples/existing-site/](../examples/existing-site/README.md):

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-<inline import map>';
worker-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self';
base-uri 'none'; form-action 'self'; frame-ancestors 'self'
```

- `'wasm-unsafe-eval'`: compiling `engine.wasm`. The engine does not use `eval`.
- `'sha256-...'`: the hash of an inline import map, if the page has one (the example computes it
  at server start); without an import map leave it out.
- `worker-src 'self'`: engine threads and the service worker (redundant with `script-src 'self'`,
  but clearer); `script-src 'self'`: `engine.js` and the audio worklet.
- `connect-src 'self'`: fetching the engine files and the Wisp WebSocket (same-origin `ws:` is
  covered in Chromium); add the relay origin (`wss://relay.example.com`) when it runs elsewhere.
- `media-src 'self' blob:`: required. Hidden media elements play `bl-media/` URLs of the service
  worker (`'self'`) and MediaSource object URLs (`blob:`); without it Chromium refuses both.
- `style-src 'self'`: the core and `@browser-lite/ui` set styles only through the CSSOM (no style
  attributes, `innerHTML` or style elements), so no `'unsafe-inline'`. Your own UI may need more.
- Neither the core nor the ui needs `img-src` or `frame-src`; add `img-src 'self' blob: data:`
  if your UI shows favicons or other images.
- `frame-ancestors 'self'`: in the iframe mode list the embedding origin instead.
- If your server sends a CSP header also with `engine.js`, that policy applies to the engine
  workers and needs `'wasm-unsafe-eval'` too (pages' WebAssembly is compiled there).

Pages inside the engine are not affected by this policy; the engine enforces their own CSP.

## Service worker

Needed only for `<video>` and `<audio>` with media files; the core never registers one.

- No own service worker: serve `@browser-lite/core/sw/sw.js` and `@browser-lite/core/sw/media-sw.js`
  (package exports, files in `dist/sw/`) from one folder and pass `serviceWorker: { url: '/sw.js' }`
  (scope default: the folder of the URL).
- Own service worker: call `importScripts('media-sw.js')` before adding your own `fetch` listener,
  register the worker yourself and pass `serviceWorker: { registration }`. `media-sw.js` adds its
  own `fetch` and `message` listeners, answers only URLs below `bl-media/` relative to the scope
  and messages with a `bl` field, and touches no lifecycle. Your own fetch logic must leave
  `bl-media/` URLs alone and keep COOP/COEP/CORP on the responses it produces.
- Call `skipWaiting()` and `clients.claim()` in the worker. Otherwise the page is not controlled
  on the first visit: the core waits 3 s for `controllerchange` and emits `media-sw-missing`.
- The scope must cover the browser page: media URLs are `<scope>bl-media/...` (with `/app/sw.js`
  the scope is `/app/`). Without a worker media files do not play and the browser emits the
  warning `media-sw-missing`.

## Relay

The engine opens TCP connections through a `Transport`; `WispTransport` talks to a Wisp relay.
`createBrowser` calls the optional `preconnect()` of the transport when the engine files start
loading, so the WebSocket handshake (3 to 4 round trips with the token) is done before the first
page (#227).

- Run `createRelay` in your Node server (`server.on('upgrade', ...)`, see the
  [server README](../packages/server/README.md)), or the `browser-lite-server` command, or the
  server image (`SERVER_IMAGE:<version>` of `versions.env`, pushed with every release; `Dockerfile`
  target `server`, built locally with `tools/build-images.sh - <tag>`; port 8080, usage in the
  [server README](../packages/server/README.md#command)) with `RELAY_SECRET` or `RELAY_TOKEN` set.
- `authorize(req, url)` is required. Use signed short-lived tokens: your backend signs with
  `signToken({ secret, ttlSeconds, audience: 'relay', subject })` after its own login, the page
  passes `token: () => fetch('/relay-token').then((r) => r.text())` so every reconnect gets a
  fresh one, and the relay checks with `authorizeToken({ secret, audience: 'relay' })`.
  `WispTransport` sends the token as a WebSocket subprotocol, never in the URL.
- `hosts`: the names users open. The origin check does not stop DNS rebinding, so set it for a
  relay that is open (the command: `ALLOWED_HOSTS`).
- `allowedOrigins`: by default only pages whose `Origin` host equals the relay's `Host`. Set it
  to exactly the origin users open when the relay runs on another host or behind a proxy (opening
  `127.0.0.1` against a `localhost` origin fails). The relay answers 403 without a valid token or
  with a wrong `Origin`.
- `clientAddress(req)`: behind a reverse proxy return the client address from the proxy's header
  (the command: `RELAY_TRUST_PROXY`), otherwise all clients share the limit `connectionsPerIp`.
- The relay connects only to public addresses and the ports 80, 443, 8080 and 8443 by default
  (`policy`).

## Storage

- `storage.namespace` (default `browserlite`) is the OPFS directory, the prefix of the Cache API
  names (`<ns>-http-v<format>`) and the Web Lock `<ns>-data`. Use one
  namespace per independent browser on an origin.
- One running browser per namespace across all tabs of the origin. A second tab gets the warning
  `storage-locked` and keeps its data in memory (the caches stay shared). One browser per page:
  a second `createBrowser` before `destroy()` throws `already-running`.
- `storage.persistent: false` keeps everything in memory (no OPFS, no HTTP cache).
- The core does not call `navigator.storage.persist()`; call it yourself if the browser data must
  not be evicted under storage pressure.
- `clearStorage(namespace)` deletes the OPFS directory and all Cache API caches of a namespace;
  it throws `storage-locked` while a browser uses it. `browser.storage.clearCaches()` empties
  only the HTTP cache.
- `storage.beforeStart(dir)` runs before the engine starts (for example `@browser-lite/profile`).

## Permissions and services

The host browser grants camera, microphone, location, notifications and so on to **your**
origin, once for all pages inside browser-lite. The engine then asks per page origin through the
`permission` handler (default: deny), and the core remembers answers in the `PermissionStore` you
pass (default: in memory). Grant `notifications` only after `Notification.requestPermission()`
of the host succeeded (the `@browser-lite/ui` prompt does this).

HTTP authentication (401 with Basic or Digest) goes to the `authenticate` handler (default:
cancel, the page shows the 401 response), like Chrome only for the main frame and same origin
loads, never for workers, `credentials: 'omit'` or requests with their own `Authorization`
header. The engine keeps the credentials in memory for the session, per realm; they are gone
after a restart of the engine. Show the `origin` of the request, not the `realm` (a text of the
server); `loginPrompt` of `@browser-lite/ui` does this.

`services` decides what pages can reach at all; a feature without its service is missing for the
pages. `defaultServices()` is `[audio(), media(), capture(), devices()]`. `webrtc()` is opt-in:
its connections bypass the relay and reveal the device's IP address. With an iframe setup also
delegate the matching `allow=` features.

## Extensions

Features of your own (or of others) that hook into requests, pages and your UI: an extension is
an object with `id`, `version` and `setup(context)`, installed on a host you pass to
`createBrowser`. Design, context and slots: [extensions.md](extensions.md).

```js
import { createBrowser, createExtensionHost } from '@browser-lite/core';
import { createUiSlots, renderToolbar } from '@browser-lite/ui';

const ui = createUiSlots();
renderToolbar(ui, document.querySelector('#extension-buttons'), () => activeView);
const extensions = createExtensionHost({ app: { ui } });
await extensions.install({
  id: 'word-count',
  version: '1.0.0',
  setup({ addScript, onMessage, app }) {
    addScript({
      matches: ['https://*/*'],
      code: 'extension.sendMessage(document.body.innerText.split(/\\s+/).length)',
    });
    let words = 0;
    onMessage((count) => {
      words = count;
      return true;
    });
    return app.ui.add('toolbar', {
      id: 'word-count.show',
      label: 'Word count',
      icon: 'W',
      action: () => alert(`${words} words`),
    });
  },
});
const browser = await createBrowser({ engineUrl, transport, extensions });
```

Install before `createBrowser` so the scripts reach the first page. Keep the host across restarts
(after a crash) and pass it to the next browser. `store` of `createExtensionHost` keeps the data
of `context.storage` (default in memory), for example in your user's profile.

## Lifecycle

- `browser.destroy()` closes all views, stops the engine threads and releases the storage lock;
  afterwards `createBrowser` can start a new one in the same page. If the old engine could not be
  stopped, `createBrowser` throws `already-running` and only a page reload helps.
- `crash` (with `reason`) means the engine is gone (`state === 'crashed'`): destroy it and create a
  new browser. `reason` holds the error (a trap or `abort()`) with the stack of the thread, at most
  4096 characters; WebAssembly frames show function names only with an engine that keeps its name
  section (the packaged engine has `wasm-function[index]:offset`), worth keeping for a bug report. Keep each view's `history` (from `navigation` events) to restore the session with
  `createView({ history })`.
- `unresponsive` fires after 10 s without an answer to input, `responsive` when it answers again.
  Offer to wait or to restart.
- `memory-pressure` (`{footprint, limit}` in bytes): the engine memory runs short. Close or
  discard background views; when none is left, tell the user (the demo shows a message).
- Storage is flushed when the page hides; `browser.storage.flush(waitMs)` writes at once.

## Browser support

Chromium (Chrome, Edge, Chromebooks) is supported. CI runs every browser suite in Firefox too
([tests/README.md](../tests/README.md)); its open failures are in [status.md](status.md), until
they are fixed Firefox does not block CI. Safari is best effort: some APIs the engine and its
services rely on are missing or behave differently there. Call `checkSupport()` before showing the
browser and fall back gracefully.

Differences in Firefox: no picture-in-picture (the pages do not see `requestPictureInPicture`),
no month and week inputs (`@browser-lite/ui` shows the date picker for them), no Compression
Dictionary Transport (engine updates come whole, as Brotli).

## Updating the engine

The engine and `@browser-lite/core` share a contract ([engine/abi.json](../engine/abi.json)):
always deploy the engine release with the same version as the core. Serve the new engine in a new
folder. Stored data in OPFS and the HTTP cache stay.

## Resource use

- Memory: one WebAssembly memory of 256 MB that grows up to 4 GB (about 1 GB in a 32 bit browser)
  and never shrinks; the engine releases caches above 192 MB, from 384 MB keeps 128 MB free ahead
  and reports `memory-pressure` when less is left below the limit it found at runtime, or above
  3 GB.
- Threads: at least 12 Web Workers (a pool of 8 plus 4 spare), more when pages start workers.
- CPU: JavaScript runs in an interpreter; large news sites take 10 to 60 s to load
  ([status.md](status.md)).
- Disk: the OPFS namespace plus the HTTP cache (at most 400 MB or a quarter of the quota).
- Network: everything of the pages goes through the relay as TLS.
