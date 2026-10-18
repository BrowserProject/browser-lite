# browser-lite

A real browser engine inside a web page: WebKit (WebCore and JavaScriptCore) compiled to
WebAssembly, packaged as libraries you can embed in your own site.

## How it works

- WebKit runs in Web Workers of your page and loads, runs and renders sites itself into a canvas:
  no URL rewriting, no pixel streaming, no VM.
- JavaScript runs in JSC's interpreter (no JIT in WASM); page WebAssembly runs in the host engine.
- Network: every TCP connection goes as a stream over one WebSocket ([Wisp](https://github.com/MercuryWorkshop/wisp-protocol))
  to a small relay. TLS happens inside the engine, the relay sees only encrypted bytes.
- Media, audio, camera, WebGL and WebCodecs use the host browser's implementations.
- Storage (cookies, IndexedDB, service workers, caches) lives in the origin private file system.

Details: [docs/architecture.md](docs/architecture.md).

## What you get

| Package | |
|---|---|
| [@browser-lite/core](packages/core/README.md) | `createBrowser`, views, input, storage, host services, media service worker |
| [@browser-lite/transport-wisp](packages/transport-wisp/README.md) | Wisp v1 client, the network of the engine |
| [@browser-lite/ui](packages/ui/README.md) | Unstyled select popup, pickers, permission prompt, dialogs, context menu |
| [@browser-lite/profile](packages/profile/README.md) | Optional server-side profile (stay signed in across devices) |
| [@browser-lite/server](packages/server/README.md) | Node: Wisp relay, static files with isolation headers, tokens, profile store, CLI |
| Engine | `engine.js`, `engine.wasm`, `engine.data` ([engine/](engine/README.md)) |

## Requirements

- A Chromium based browser (Chrome, Edge, Chromebooks). Firefox and Safari are best effort.
- A cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) over HTTPS, with the engine on the same origin.
- A relay: Node 22 or newer with `@browser-lite/server`, or the server image of the release.

## Install

Until the packages are on npm, every GitHub release carries the package tarballs
(`browser-lite-<package>-<version>.tgz` for core, transport-wisp, ui, profile and server), the
engine (`browser-lite-engine-<version>.tar.gz`) and `SHA256SUMS`:

```bash
npm install ./browser-lite-core-0.1.0.tgz ./browser-lite-transport-wisp-0.1.0.tgz
npm install ./browser-lite-server-0.1.0.tgz      # on the server
```

Unpack the engine archive of the same release (`engine.js`, `engine.wasm`, `engine.data` with
`.br`/`.gz`, `manifest.json`, `THIRD_PARTY_NOTICES.txt`) into a folder of your site named after
the version; engine and core versions must match:

```bash
mkdir -p public/engine/0.1.0
tar -xzf browser-lite-engine-0.1.0.tar.gz --strip-components=1 -C public/engine/0.1.0
```

Every engine version gets a new folder, so its files can be cached as immutable
([Serving the engine](docs/embedding.md#serving-the-engine)).

## Quick start

```js
import { createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const browser = await createBrowser({
  engineUrl: '/engine/0.1.0/',
  transport: new WispTransport({ url: '/wisp/', token: () => fetch('/relay-token').then((r) => r.text()) }),
  serviceWorker: { url: '/sw.js' }, // @browser-lite/core/sw/sw.js and media-sw.js, for <video>/<audio>
});
const view = browser.createView({ container: document.querySelector('#browser'), url: 'https://example.com/' });
view.on('title', ({ title }) => (document.title = title));
```

On the server:

```js
import { createRelay } from '@browser-lite/server';
import { authorizeToken } from '@browser-lite/server/token';

const authorize = authorizeToken({ secret: process.env.RELAY_SECRET, audience: 'relay' });
const relay = createRelay({ authorize });
httpServer.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head) || socket.destroy());
```

Headers, service worker, CSP, storage and lifecycle: [docs/embedding.md](docs/embedding.md).
Complete, tested setups: [examples/](examples/README.md).
Before production: [docs/security.md](docs/security.md).

## Limitations

JavaScript is slower than in a normal browser (big news sites take 10 to 60 s to load). No DRM,
no WebGPU, no shared-memory WebAssembly. Some sites block the relay's datacenter IP. Everything
the pages do runs in your origin: no third-party scripts on the browser page. More in
[docs/status.md](docs/status.md) and [docs/compatibility.md](docs/compatibility.md).

## Try the demo

`apps/demo` is a full browser (tabs, history, bookmarks, settings, profile) on the packages. It
runs with an engine from CI (artifact `engine` of a green run) in `build/webcore/bin/`; commands,
URL parameters and modules: [apps/demo/README.md](apps/demo/README.md); deployment on the home
server: [apps/demo/deploy/README.md](apps/demo/deploy/README.md).

## Build the engine

Docker toolchain, WebKit fetch, patches, dependencies and the engine build (hours the first
time): [docs/build.md](docs/build.md).

## Repository layout

```
engine/        WebKit embedder (C++ and JS), patches/ for WebKit, abi.json (contract with the core)
packages/      npm packages: core, transport-wisp, ui, profile, server
apps/demo/     the demo browser (Vite) and deploy/ for the home server
examples/      copyable embedding templates: minimal (own route) and existing-site
tests/         contract, engine, JSC and browser suites (tests/README.md)
tools/         build, patch, packaging and style scripts
toolchain/     Docker image with Emscripten and the build tools
deps/          libraries built for WASM (ICU, OpenSSL, curl, fonts, ...)
docs/          documentation (below)
versions.env   version pins
```

## Documentation

| File | |
|---|---|
| [docs/embedding.md](docs/embedding.md) | Embedding in a site: modes, headers, engine files, CSP, service worker, relay, storage, lifecycle |
| [examples/README.md](examples/README.md) | Tested templates: own route with Vite, part of an existing site with its own service worker and CSP |
| [docs/security.md](docs/security.md) | Threat model and production checklist |
| [docs/architecture.md](docs/architecture.md) | Layers, threads, frames, network, storage, media, GC |
| [docs/build.md](docs/build.md) | Building the packages and the engine, CI |
| [docs/compatibility.md](docs/compatibility.md) | Real sites and the yardstick against Chromium |
| [docs/status.md](docs/status.md) | What works, measurements, open items, plans |
| [docs/decisions.md](docs/decisions.md) | Decisions and why |
| [docs/licensing.md](docs/licensing.md) | Licenses and obligations when distributing the engine |
| [AGENTS.md](AGENTS.md) | Rules for working on the repository |

## License

Our code is BSD-2-Clause ([LICENSE](LICENSE)). The engine contains WebKit (LGPL-2.1 and BSD) and
other libraries; what that means when you serve it: [docs/licensing.md](docs/licensing.md).
