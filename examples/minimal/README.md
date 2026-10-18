# examples/minimal/

browser-lite on its own cross-origin isolated route: one view that fills the page, an address
input, the default UI handlers of `@browser-lite/ui`, the Wisp transport and the media service
worker of the core. Vite and TypeScript.

## Run

```bash
node packages/server/dist/bin/browser-lite-server.js        # relay on :5001 (separately)
ENGINE_DIR=/path/to/engine npm run copy-engine              # engine into public/engine/
npm run dev                                                 # http://localhost:5173/
npm run build && npm run preview                            # production build in dist/
```

`?url=https://example.org/` opens another first page. `RELAY_URL` points the dev and preview
proxy for `/wisp/` to another `browser-lite-server` (default `http://localhost:5001`). Without a
token the server's relay is open to everyone who reaches it: only for internal use, see
[packages/server](../../packages/server/README.md) for `RELAY_TOKEN` and `RELAY_SECRET`.

## Files

| File | |
| --- | --- |
| `src/main.ts` | `createBrowser`, one view, address form, context menu and link status |
| `vite.config.ts` | COOP/COEP/CORP for dev and preview, `/wisp/` proxy, plugin that serves and emits `sw.js` and `media-sw.js` of the core at the root |
| `scripts/copy-engine.mjs` | copies `ENGINE_DIR` into `public/engine/` (Vite serves it and copies it into the build) |
| `src/style.css` | layout and a few styles for the unstyled ui elements |

## Hosting the build

`dist/` is a static site. The server must send `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` with
every file (`serveStatic` of `@browser-lite/server/static` does), serve `.wasm` as
`application/wasm`, and forward `/wisp/` (WebSocket) to the relay. `sw.js` must stay at the root
of the site, so its scope covers the page.
