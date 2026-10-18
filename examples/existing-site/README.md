# examples/existing-site/

browser-lite as one part of an existing website with a Node backend: the site keeps its own
pages, login and service worker, and serves the browser under `/app/`. Plain `node:http` and
plain HTML with an import map, no bundler.

## Run

```bash
ENGINE_DIR=/path/to/engine node server.mjs      # http://localhost:8080/
```

Open the home page, sign in (a fake session cookie), then open one of the three pages.
`?url=https://example.org/` opens another first page.

| Variable | |
| --- | --- |
| `ENGINE_DIR` | folder with `engine.js`, `engine.wasm`, `engine.data` (required) |
| `PORT`, `HOST` | default `8080`, `127.0.0.1` |
| `PUBLIC_ORIGIN` | origin the users open (relay origin check), default `http://localhost:PORT` |
| `RELAY_SECRET` | secret for the relay tokens (at least 32 characters), default random per start |
| `RELAY_ALLOW_LOCAL` | `1`: relay may reach local addresses and every port, tests only |

## What it shows

| URL | |
| --- | --- |
| `/` | the site's own pages, no special headers |
| `POST /login`, `/session`, `/token` | session cookie (`Secure` behind an https `PUBLIC_ORIGIN`); `/session` answers 204 or 401; `/token` gives signed-in users a relay token valid for 60 s (`signToken` with audience `relay`), else 401; `WispTransport` sends it as a WebSocket subprotocol, never in the URL |
| `/app/` | the browser in a section of an ordinary page |
| `/app/iframe.html` | the browser page `frame.html` in an iframe of an isolated parent |
| `/app/csp.html` | the browser under a strict Content Security Policy |
| `/app/wisp/` | relay (`createRelay` with `authorizeToken` and `allowedOrigins`) |
| `/app/engine/`, `/app/lib/` | engine files, dist folders of the packages for the import map |
| `/app/sw.js` | the site's own service worker; first line `importScripts('media-sw.js')` |

`app/main.js` checks `/session` first, asks `/token` for every relay connection (`WispTransport` `token` function),
registers `sw.js` itself and passes the registration (`serviceWorker: { registration }`), and
uses its own storage namespace.

## Hosting notes

- Headers: every response under `/app/` carries `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`
  (`serveStatic` sends them). Pages outside `/app/` stay as they are. Everything an isolated
  page loads from another origin needs CORS or `Cross-Origin-Resource-Policy: cross-origin`.
- Service worker: its scope must cover the browser pages (here `/app/`). `media-sw.js` answers
  only `bl-media/` below the scope and messages with a field `bl`; the site's own fetch handler
  must leave those alone and keep COOP/COEP/CORP on the responses it answers. The worker
  calls `skipWaiting()` and `clients.claim()`, else videos play only after a reload.
- Iframe: a frame is only cross-origin isolated if its parent is, so the parent page needs the
  same headers. The `allow` attribute lists the features the services use:
  `cross-origin-isolated; fullscreen; autoplay; picture-in-picture; clipboard-read;
  clipboard-write; camera; microphone; display-capture; geolocation; gamepad; accelerometer;
  gyroscope; magnetometer; keyboard-map`. A frame from the same origin has most of them by
  default; a frame from another origin needs all of them and its responses need
  `Cross-Origin-Resource-Policy: cross-origin` (or `same-site`).
- Content Security Policy (`/app/csp.html`, verified by `tests/examples/existing-site-test.mjs`):
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-<import map>';
  worker-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self';
  base-uri 'none'; form-action 'self'; frame-ancestors 'self'`.
  `'wasm-unsafe-eval'` compiles the engine, `media-src 'self'` covers the service worker URLs of
  `<video>`, `blob:` the Media Source Extensions. The core and the ui set styles only through
  the CSSOM, so `style-src` needs no `'unsafe-inline'`. A relay on another origin goes into
  `connect-src` (`wss://relay.example.org`). The server computes the hash of the inline import
  map at start.
- Relay: `allowedOrigins` lists the origin of the pages; tokens are short-lived and fetched per
  connection, so they never sit in the page URL or in storage.
