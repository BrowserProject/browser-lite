# examples/

Copyable templates that use only the public packages (`@browser-lite/core`,
`@browser-lite/transport-wisp`, `@browser-lite/ui`, `@browser-lite/server`). Both need an engine
build (`engine.js`, `engine.wasm`, `engine.data`), for example the artifact `engine` of a CI run
or `build/webcore/bin` of an own build ([docs/build.md](../docs/build.md)).

| Example | Embedding mode | Use it when |
| --- | --- | --- |
| [minimal/](minimal/README.md) | (a) own cross-origin isolated route or site | the browser gets its own page or (sub)domain; Vite and TypeScript |
| [existing-site/](existing-site/README.md) | (b) part of an existing website | the site has its own backend, login, service worker or CSP; plain `node:http`, no bundler |

The engine needs `SharedArrayBuffer`, so the page that runs it must be cross-origin isolated
(COOP `same-origin`, COEP `require-corp`). That isolates the whole page: third-party iframes,
scripts and images without CORP or CORS stop loading. Mode (a) keeps this away from the rest of
the site; mode (b) isolates only the pages under `/app/`.

## Run

```bash
npm ci && npm run build                     # in the repository: the packages (dist/)

# (a) minimal: relay in one terminal, Vite in another
HOST=127.0.0.1 npm run relay -w @browser-lite/example-minimal   # relay on 127.0.0.1:5001
ENGINE_DIR=build/webcore/bin npm run copy-engine -w @browser-lite/example-minimal
npm run dev -w @browser-lite/example-minimal                       # http://localhost:5173/

# (b) existing-site: one Node process with pages, tokens, relay and engine
ENGINE_DIR=build/webcore/bin node examples/existing-site/server.mjs   # http://localhost:8080/
```

## Copy

Copy the folder of the example into your project. Everything an example needs is inside its
folder (the `minimal` tsconfig does not extend the repository's); the package versions in its
`package.json` are the ones of this repository. The packages are not on npm yet: put the tarballs
of the matching release next to `package.json`, point the dependencies at them
(`"@browser-lite/core": "file:./browser-lite-core-0.1.0.tgz"`, the same for the others), then
run `npm install` ([README, Install](../README.md#install)). Inside this repository the examples
use the workspace packages instead.

## Test

`node tests/run.mjs examples [--engine=<dir>]` ([tests/examples](../tests/README.md), Playwright
Chromium) starts both examples with the engine and checks: rendering and title events, the token
flow of the relay (403 without a token, with the token in the URL or from another origin), a
video through the media part of the site's own service worker, the iframe page, the strict CSP
page (video, Media Source Extensions, Web Audio, context menu, no violations), and for `minimal`
the Vite build, `npm run relay` and the preview (COOP/COEP/CORP on the engine files) with a page
through the relay.
