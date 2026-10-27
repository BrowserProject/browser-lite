# @browser-lite/server

Node server parts of browser-lite: the Wisp v1 relay that carries the engine's TCP connections,
static files with the cross-origin isolation headers the engine needs, relay tokens, the store of
the server-side browser profile, and the `browser-lite-server` command that combines them.
Node 22 or newer, no framework.

## Install

Not on npm yet: install the tarball of a GitHub release
([README, Install](../../README.md#install)), or run the server image of the release.

## Example

```js
import http from 'node:http';
import { createProfileStore, createRelay } from '@browser-lite/server';
import { serveStatic } from '@browser-lite/server/static';
import { authorizeToken } from '@browser-lite/server/token';

const secret = process.env.RELAY_SECRET;
// Your backend signs tokens after its own login, one per audience:
// signToken({ secret, ttlSeconds: 60, audience: 'relay', subject: user })
const relay = createRelay({ authorize: authorizeToken({ secret, audience: 'relay' }) });
const profile = createProfileStore({
  dir: '/var/lib/browser-lite',
  // The name users open (DNS rebinding protection; IP addresses and localhost always pass)
  hosts: ['browser.example.com'],
  authorize: authorizeToken({ secret, audience: 'profile' }),
});

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

Tokens never travel in URLs (they end up in proxy logs): `WispTransport` sends its token as a
WebSocket subprotocol, the profile client as `Authorization: Bearer`. A signed token opens only
its audience, so a relay token never opens the profile with the user's sign-ins.

## API

`@browser-lite/server`

| Export | |
| --- | --- |
| `createRelay(options)` | Wisp relay; `handleUpgrade(req, socket, head)` returns false for other paths, `close()` |
| `createProfileStore({ dir, authorize, path?, maxBytes?, hosts?, logger? })` | profile under `path` (default `/profile/`, protocol below); `handle(req, res)`, `close()`. `authorize(req, url)` is required like for the relay (the profile holds the sign-ins; `() => true` only for a store reachable by its user alone) |

`RelayOptions`: `authorize(req, url)` (required, may be async; pass `() => true` for an open
relay), `path` (`/wisp/`), `allowedOrigins` (full origins, `'*'`, or a function; default: the
host of `Origin` equals `Host`; requests without `Origin` pass), `hosts` (host names besides IP
addresses and `localhost`, `.suffix` for all names ending so; other `Host` headers get 403;
default every host), `clientAddress(req)` (default the socket address; behind a proxy read the
proxy's header), `policy`, `logger`.

`RelayPolicy` (per relay instance, so several relays with different rules can run in one
process):

| Field | Default | |
| --- | --- | --- |
| `allowPrivateAddresses` | `false` | allow loopback, private and other non-public addresses (tests) |
| `ports` | `[80, 443, 8080, 8443]` | allowed target ports, or `'any'` |
| `streamsPerConnection` | 256 | open streams per WebSocket |
| `streamsPerHost` | 64 | open streams per WebSocket to one host name and port |
| `connectionsPerIp` | 16 | WebSockets per client address (HTTP 429 beyond); a `WispTransport` uses 3 by default |
| `maxPayload` | 64 KiB + 5 | largest WebSocket message (the largest packet of `WispTransport`) |
| `idleTimeoutMs` | 0 | close streams without traffic after this time; 0 never |

`@browser-lite/server/static`: `serveStatic(req, res, root, { urlPath?, cacheControl?, corp? })`
(GET/HEAD, `.br`/`.gz` next to the file, ETag/304, single byte ranges; resolves false when it
sent nothing), `coiHeaders({ corp? })` (COOP, COEP, CORP), `contentType(path)`.

`@browser-lite/server/token`: `signToken({ secret, ttlSeconds, audience, subject? })` (claims
`{ exp, aud, sub? }`), `verifyToken(secret, token, audience)` (`{ subject? }` or null),
`authorizeToken({ token?, secret?, audience? })` (the static token, or a token signed for
`audience`, required with `secret`; read from the WebSocket subprotocol `bl-token.<base64url>`
or `Authorization: Bearer`, never from the URL; static tokens need 16 characters, secrets 32).

## Command

`browser-lite-server` serves the relay under `/wisp/`, optionally a site and the profile, and
`/healthz`, on one port. SIGTERM and SIGINT close connections and end with code 0. The server
image (`SERVER_IMAGE:<version>` of `versions.env`, `Dockerfile` target `server`) runs it as user
`node` with a healthcheck and the same variables, but `PORT` is 8080 there:
`docker run -p 8080:8080 -e RELAY_SECRET=... -e ALLOWED_HOSTS=browser.example.com <image>`.

| Variable | |
| --- | --- |
| `PORT`, `HOST` | default `5001`, `0.0.0.0` |
| `SITE_DIR` | directory of the built site (for example `tools/package-demo.sh`); `/engine/` is cached as immutable, so every engine version needs its own folder below it, and so are files of `/assets/` with a content hash in their name like Vite writes them (`index-Vc6q4Bex.js`) |
| `PROFILE_DIR` | directory of the profile; without it `/profile/` answers 404 |
| `PROFILE_MAX_MB` | limit of the profile, default 64 |
| `ALLOWED_HOSTS` | host names of relay and profile besides IP addresses and `localhost`, comma separated (`.ts.net` matches all names ending so); other `Host` headers get 403 (DNS rebinding) |
| `RELAY_TOKEN` | static token (at least 16 characters) for relay and profile |
| `RELAY_SECRET` | secret (at least 32 characters) for tokens made with `signToken`: audience `relay` for the relay, `profile` for the profile |
| `RELAY_ALLOWED_ORIGINS` | allowed origins, comma separated, `*` for any; default same host |
| `RELAY_TRUST_PROXY` | number of reverse proxies in front; the client address is read from `X-Forwarded-For` |
| `RELAY_ALLOW_LOCAL` | `1`: local addresses and all ports, for tests only |

Without `RELAY_TOKEN` and `RELAY_SECRET` relay and profile are open to everyone who reaches the
server: only for internal use. Prefer short-lived signed tokens (`RELAY_SECRET`) over a static
`RELAY_TOKEN`.

## Security

Threat model and production checklist: [docs/security.md](../../docs/security.md).

- Only global unicast addresses unless `allowPrivateAddresses` (IPv4-mapped IPv6 is converted
  first, so `::ffff:127.0.0.1`, `fd00::/8`, NAT64 and link-local are blocked). The relay resolves
  the name itself and connects only to the checked addresses (no DNS rebinding), IPv6 and IPv4
  interleaved like a browser.
- Only TCP streams and allowed ports; reasons for failed streams are sent to the client
  ([PROTOCOL.md](../transport-wisp/PROTOCOL.md)).
- The origin check protects against cross-site WebSocket hijacking, not against DNS rebinding
  (the rebound page is same-origin): `hosts` (the command: `ALLOWED_HOSTS`) does. The token
  decides who may use the relay. Stream contents and tokens are never logged.
- Client data waiting for a slow target is limited (2 * 128 packets of `maxPayload` per stream,
  at least 32 MiB per connection, closed streams included until their socket is gone).

## Profile store

Exactly one browser profile: cookies, localStorage and small IndexedDBs (paths as in `/data` of
the engine) and the prefs of the page (JSON values by name). Under `dir`:
`profile.json` (id, active session, device), `files/<path>`, `prefs/<name>.json`, `tmp/`. Every
file is written atomically (tmp, fsync, rename). If the directory is not writable the server
still runs and the endpoint answers 503. The paths below use the default `path`.

| Request | |
| --- | --- |
| `POST /profile/open` `{ "device" }` | only with `Content-Type: application/json` (else 415); starts a new session that is from now on the only one that writes. Answer (gzip if accepted): `u32 LE` length of the header, header JSON `{ id, session, created, prefs, files: [{ path, size }] }`, then all files in a row |
| `PUT /profile/files/<path>` | raw bytes, 204 |
| `DELETE /profile/files/<path>` | 204, also when already gone; empty directories go too |
| `PUT /profile/prefs/<name>` | JSON (at most 1 MB), 204; names `^[a-z][a-z0-9-]{0,31}$` (else 400), at most 32 prefs of 4 MB together (else 507) |
| `POST /profile/reset` `{ "all", "prefs" }` | deletes the files and the listed prefs, with `all` every pref, new id, 204 |
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
- `authorize` decides (the command: `RELAY_TOKEN` or a token signed for audience `profile`, as
  `Authorization: Bearer`), else 403. The files are stored unencrypted on the server.

## Tests

```bash
npm run build && npm test -w @browser-lite/server
```
