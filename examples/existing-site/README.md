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

`app/main.js` checks `/session` first, asks `/token` for every relay connection (`WispTransport`
`token` function), registers `sw.js` itself and passes the registration
(`serviceWorker: { registration }`), and uses its own storage namespace.

## Hosting notes

The rules behind these points are in [docs/embedding.md](../../docs/embedding.md); this is where
the example applies them.

- [Headers](../../docs/embedding.md#headers): `server.mjs` serves everything under `/app/`
  with `serveStatic`, which sends COOP, COEP and CORP; pages outside `/app/` stay as they are.
- [Service worker](../../docs/embedding.md#service-worker): `app/sw.js` (scope `/app/`) loads
  `media-sw.js` first, calls `skipWaiting()` and `clients.claim()`, and its own fetch handler
  answers only its own URL, so the isolation headers of the other responses stay.
- [Iframe](../../docs/embedding.md#embedding-modes): `app/iframe.html` is isolated like the
  frame and carries the tested `allow` list.
- [Content Security Policy](../../docs/embedding.md#content-security-policy): `server.mjs`
  sends it with `/app/csp.html` only and computes the hash of the inline import map at start;
  `tests/examples/existing-site-test.mjs` checks that no violation occurs.
- [Relay](../../docs/embedding.md#relay): `allowedOrigins` is `PUBLIC_ORIGIN`; tokens are
  short-lived and fetched per connection, so they never sit in the page URL or in storage.
