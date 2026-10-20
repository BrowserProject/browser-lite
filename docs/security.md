# Security

browser-lite runs untrusted web pages inside your page. The engine isolates the pages from each
other like WebKit does, but everything runs in **your origin** and **your realm**. This page lists
what that means and what to do before going to production. Setup details: [embedding.md](embedding.md).

## Threat model

| Risk | Why | Mitigation |
|---|---|---|
| Scripts on the browser page reach everything | The engine's memory (`SharedArrayBuffer`), the Emscripten module and all its workers live in the host realm. Any script there can read cookies, passwords and page contents of every site the user visits inside browser-lite | No third-party scripts (analytics, ads, tag managers) on the page that runs the browser. Use a dedicated subdomain and a strict CSP |
| Storage is origin-wide | The namespace directory in OPFS (cookies, localStorage, IndexedDB of all sites), the HTTP cache and the locks belong to the origin, not the route: any script on any page of that origin can read them | In production use a dedicated subdomain; with a route the whole origin must be free of untrusted scripts |
| Cache timing across sites | A page could tell from cache hits whether the user visited another site | The persistent HTTP and bytecode caches are partitioned like Chrome's HTTP cache (top site, frame site, subframe document; #213 in [decisions.md](decisions.md)), so this side channel is closed for them. WebKit's memory cache is not partitioned: while the engine runs, all views share it, so a resource another site loaded in the same session can still come faster. It is emptied when the engine restarts |
| Debug hooks | `debug: true` exposes `browser.debug` (eval in pages, memory reports, crash, raw module) and enables the engine test hooks (`BL_TEST_HOOKS`) | Only in development. The demo enables it only with `?debug=1` |
| Extra CA certificates | A trusted extra CA lets whoever holds its key read all TLS inside the engine | `engine.extraCA` only from code you control; never from URL parameters or stored settings. `engine.env` rejects `BL_EXTRA_CA` |
| Relay as an open proxy | Anyone who can reach the relay can make TCP connections from your server | `authorize` is required (signed tokens with a short TTL), `allowedOrigins` against cross-site WebSocket hijacking, `hosts` against DNS rebinding (the origin check does not stop it), per-address limits (`connectionsPerIp`, `clientAddress` behind proxies), stream, buffer and timeout limits in `policy` |
| SSRF through the relay | Pages could reach your LAN, loopback or cloud metadata services | The relay connects only to public unicast addresses and web ports, checks the address it actually connects to (DNS rebinding safe). `allowPrivateAddresses` and `RELAY_ALLOW_LOCAL` only in tests |
| WebRTC reveals the IP | Peer connections use the host browser's network, not the relay | `webrtc()` is opt-in; enable it only when users expect it |
| Error page in the failed site's origin | The engine shows its error page under the URL that failed, so a malicious template would run in that site's origin | The engine HTML-escapes every placeholder and prepends a CSP without scripts (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`); the retry button is the engine's own listener. Keep custom `errorPage` templates static |
| Permissions under your origin | The host browser grants camera, location, notifications to your origin once, for all pages inside | Keep the `permission` handler asking per page origin, persist decisions in a `PermissionStore` you control, offer a way to revoke them |
| Profile on the server | `createProfileStore` stores cookies (sign-ins) unencrypted | `authorize` is required, with its own token audience (`profile`) so a relay token never opens it; the store also checks `Host` (DNS rebinding) and refuses simple cross-site requests |

The relay sees only encrypted bytes (TLS happens inside the engine), but it sees target host
names and ports, and timing.

## Production checklist

- The browser runs on its own subdomain (a route only if no page of the origin runs untrusted
  scripts), served with COOP, COEP and CORP.
- No third-party scripts on that page; a CSP like the one in [embedding.md](embedding.md).
- `debug` is false; no `engine.env` from user input; `engine.extraCA` unset or from code.
- Engine files same-origin, versioned folder, matching the core version.
- Relay: `authorize` with signed short-lived tokens (`signToken` with an audience, secret of at
  least 32 characters) rather than a static token, `allowedOrigins` and `hosts` set explicitly,
  `clientAddress` correct behind your proxy, `allowPrivateAddresses` false, limits reviewed.
- The relay and profile endpoints are not reachable without a token (the `browser-lite-server`
  command without `RELAY_TOKEN` or `RELAY_SECRET` is open: internal use only).
- `webrtc()` only if wanted; `services` limited to what you need.
- A `PermissionStore` with a way for users to see and revoke decisions.
- HTTPS everywhere (cross-origin isolation needs a secure context).
- Tokens are never logged and never in URLs (the server package does not log them and reads them
  only from the WebSocket subprotocol or `Authorization`; check your proxy).

