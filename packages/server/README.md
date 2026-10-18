# @browser-lite/server

Node server parts of browser-lite: the Wisp v1 relay that carries the engine's TCP connections,
static files with the cross-origin isolation headers the engine needs, relay tokens, the store of
the server-side browser profile, and the `browser-lite-server` command that combines them.
Node 22 or newer, no framework.

## Install

```bash
npm install @browser-lite/server
```

## Example

```js
import http from 'node:http';
import { createProfileStore, createRelay } from '@browser-lite/server';
import { serveStatic } from '@browser-lite/server/static';
import { authorizeToken } from '@browser-lite/server/token';

const authorize = authorizeToken({ secret: process.env.RELAY_SECRET });
const relay = createRelay({ authorize });
const profile = createProfileStore({ dir: '/var/lib/browser-lite', authorize });

const server = http.createServer(async (req, res) => {
  if (await profile.handle(req, res)) return;
  if (await serveStatic(req, res, './site')) return;
  res.writeHead(404).end();
});
server.on('upgrade', (req, socket, head) => {
  if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(8080);
```

## API

`@browser-lite/server`

| Export | |
| --- | --- |
| `createRelay(options)` | Wisp relay; `handleUpgrade(req, socket, head)` returns false for other paths, `close()` |
| `createProfileStore({ dir, maxBytes?, hosts?, authorize?, logger? })` | profile under `/profile/` (protocol below); `handle(req, res)`, `close()` |

`RelayOptions`: `authorize(req, url)` (required, may be async; pass `() => true` for an open
relay), `path` (`/wisp/`), `allowedOrigins` (full origins, `'*'`, or a function; default: the
host of `Origin` equals `Host`; requests without `Origin` pass), `clientAddress(req)` (default
the socket address; behind a proxy read the proxy's header), `policy`, `logger`.

`RelayPolicy` (per relay instance, so several relays with different rules can run in one
process):

| Field | Default | |
| --- | --- | --- |
| `allowPrivateAddresses` | `false` | allow loopback, private and other non-public addresses (tests) |
| `ports` | `[80, 443, 8080, 8443]` | allowed target ports |
| `streamsPerConnection` | 256 | open streams per WebSocket |
| `streamsPerHost` | 64 | open streams per WebSocket to one host name and port |
| `connectionsPerIp` | 16 | WebSockets per client address (HTTP 429 beyond) |
| `maxPayload` | 1 MiB | largest WebSocket message |
| `idleTimeoutMs` | 0 | close streams without traffic after this time; 0 never |

`@browser-lite/server/static`: `serveStatic(req, res, root, { urlPath?, cacheControl?, corp? })`
(GET/HEAD, `.br`/`.gz` next to the file, ETag/304, single byte ranges; resolves false when it
sent nothing), `coiHeaders({ corp? })` (COOP, COEP, CORP), `contentType(path)`.

`@browser-lite/server/token`: `signToken({ secret, ttlSeconds, subject? })`,
`verifyToken(secret, token)`, `authorizeToken({ token?, secret? })` (accepts `?token=` and
`Authorization: Bearer`; static tokens need 16 characters, secrets 32).

## Command

`browser-lite-server` serves the relay under `/wisp/`, optionally a site and the profile, and
`/healthz`, on one port. SIGTERM and SIGINT close connections and end with code 0.

| Variable | |
| --- | --- |
| `PORT`, `HOST` | default `5001`, `0.0.0.0` |
| `SITE_DIR` | directory of the built site (`tools/package-site.sh`); `/engine/` is cached as immutable |
| `PROFILE_DIR` | directory of the profile; without it `/profile/` answers 404 |
| `PROFILE_MAX_MB` | limit of the profile, default 64 |
| `PROFILE_HOSTS` | further host names for `/profile/`, comma separated (`.ts.net` matches all names ending so) |
| `RELAY_TOKEN` | static token (at least 16 characters) for relay and profile |
| `RELAY_SECRET` | secret (at least 32 characters) for tokens made with `signToken` |
| `RELAY_ALLOWED_ORIGINS` | allowed origins, comma separated, `*` for any; default same host |
| `RELAY_TRUST_PROXY` | number of reverse proxies in front; the client address is read from `X-Forwarded-For` |
| `RELAY_ALLOW_LOCAL` | `1`: local addresses and all ports, for tests only |

Without `RELAY_TOKEN` and `RELAY_SECRET` relay and profile are open to everyone who reaches the
server: only for internal use.

## Security

- Only global unicast addresses unless `allowPrivateAddresses` (IPv4-mapped IPv6 is converted
  first, so `::ffff:127.0.0.1`, `fd00::/8`, NAT64 and link-local are blocked). The relay resolves
  the name itself and connects only to the checked addresses (no DNS rebinding), IPv6 and IPv4
  interleaved like a browser.
- Only TCP streams and allowed ports; reasons for failed streams are sent to the client
  ([PROTOCOL.md](../transport-wisp/PROTOCOL.md)).
- The origin check protects against cross-site WebSocket hijacking; the token decides who may
  use the relay. Stream contents and tokens are never logged.

## Profile store

Exactly one browser profile: cookies, localStorage and small IndexedDBs (paths as in `/data` of
the engine) and the prefs of the UI (settings, bookmarks, permissions). Under `dir`:
`profile.json` (id, active session, device), `files/<path>`, `prefs/<name>.json`, `tmp/`. Every
file is written atomically (tmp, fsync, rename). If the directory is not writable the server
still runs and `/profile/` answers 503.

| Request | |
| --- | --- |
| `POST /profile/open` `{ "device" }` | only with `Content-Type: application/json` (else 415); starts a new session that is from now on the only one that writes. Answer (gzip if accepted): `u32 LE` length of the header, header JSON `{ id, session, created, prefs, files: [{ path, size }] }`, then all files in a row |
| `PUT /profile/files/<path>` | raw bytes, 204 |
| `DELETE /profile/files/<path>` | 204, also when already gone; empty directories go too |
| `PUT /profile/prefs/<name>` | JSON (at most 1 MB), 204 |
| `POST /profile/reset` `{ "all" }` | deletes files and permissions, with `all` also settings and bookmarks, new id, 204 |
| `GET /profile/info` | `{ id, created, updated, device, opened, maxBytes, bytes, files: [{ path, size, modified }], cookies }`; `cookies` per domain via `node:sqlite`, else (or without a real table `Cookie`) null |

- Writing needs `X-Profile-Session` of the active session, else 409 `{ "reason": "taken" }`
  (another device opened) or `{ "reason": "reset" }` (reset since). The session lives in
  `profile.json`, so it survives a restart.
- Allowed paths (else 400): `cookies.db`, `localstorage/<name>.localstorage`,
  `indexeddb/v1/<a>/<b>/<file>`, `indexeddb/v1/<a>/<b>/<c>/<file>`. Names not empty, without
  `/`, `\` and null byte, not starting with `.`, at most 255 bytes.
- One file at most 32 MB (413, also while reading a body without Content-Length), the whole
  profile at most `maxBytes` (507). Other files in `files/` are never sent or counted. `info`
  opens `cookies.db` read-only and immutable, without code from the schema.
- Against DNS rebinding only with `Host` as an IP address, `localhost` or a name from `hosts`,
  else 403. Against CSRF no call is a simple cross-site request (there is no CORS): `open` needs
  JSON, the other writing calls PUT/DELETE or `X-Profile-Session`.
- With `authorize` (the command: `RELAY_TOKEN`/`RELAY_SECRET` as `Authorization: Bearer`) else
  403. The files are stored unencrypted on the server.

## Tests

```bash
npm run build && npm test -w @browser-lite/server
```
