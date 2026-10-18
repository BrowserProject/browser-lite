# examples/minimal/

browser-lite on its own cross-origin isolated route: one view that fills the page, an address
input, the default UI handlers of `@browser-lite/ui`, the Wisp transport and the media service
worker of the core. Vite and TypeScript.

## Run

```bash
HOST=127.0.0.1 npm run relay                                # relay on 127.0.0.1:5001 (separately)
ENGINE_DIR=/path/to/engine npm run copy-engine              # engine into public/engine/
npm run dev                                                 # http://localhost:5173/
npm run build && npm run preview                            # production build in dist/
```

`?url=https://example.org/` opens another first page. `npm run relay` starts `browser-lite-server`
of `@browser-lite/server`. Without `RELAY_TOKEN` or `RELAY_SECRET` its relay is open to everyone
who reaches it, so keep it on `127.0.0.1` (the CLI listens on all interfaces by default); the
README of `@browser-lite/server` describes tokens and the other settings. `RELAY_URL` points the
dev and preview proxy for `/wisp/` to another relay (default `http://127.0.0.1:5001`).

## Files

| File | |
| --- | --- |
| `src/main.ts` | `createBrowser`, one view, address form, context menu and link status |
| `vite.config.ts` | COOP/COEP/CORP for dev and preview, `/wisp/` proxy, plugin that serves and emits `sw.js` and `media-sw.js` of the core (resolved through its package exports) at the root |
| `scripts/copy-engine.mjs` | copies `ENGINE_DIR` into `public/engine/` (Vite serves it and copies it into the build) |
| `src/style.css` | layout and a few styles for the unstyled ui elements |

## Hosting the build

`dist/` is a static site. The server must send `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` with
every file (`serveStatic` of `@browser-lite/server/static` does), serve `.wasm` as
`application/wasm`, and forward `/wisp/` (WebSocket) to the relay. `sw.js` must stay at the root
of the site, so its scope covers the page. The engine is in the unversioned `engine/`, so it must
not be cached as immutable: `browser-lite-server` with `SITE_DIR` does that for `/engine/`, and
returning visitors would keep an old engine next to a new core. Move it to a folder per version
and change `engineUrl` in `src/main.ts`, or serve it with revalidation
([Serving the engine](../../docs/embedding.md#serving-the-engine)).
