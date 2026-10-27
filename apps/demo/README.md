# apps/demo/

The full demo browser on browser-lite: tabs (with popups, restored tabs that load on the first
click, discarding under memory pressure and a message when none is left), address bar with
suggestions, history, bookmarks, downloads panel, settings page with profile and device
emulation, find bar, zoom, print preview, keyboard shortcuts, security indicator, crash and hang
handling, a progress bar while the engine downloads (an address typed meanwhile opens once it
runs). Built with Vite and only the public APIs of `@browser-lite/core`, `@browser-lite/ui`,
`@browser-lite/profile` and `@browser-lite/transport-wisp`. Deployment on the home server:
[deploy/](deploy/README.md).

## Run

```bash
npm ci && npm run build                                   # the packages (dist/)
PROFILE_DIR=build/profile node packages/server/dist/bin/browser-lite-server.js &   # :5001
npm run dev -w @browser-lite/demo                         # http://localhost:5173/
```

The Vite dev server sends the COOP/COEP headers, serves the engine under `/engine/` from
`BL_ENGINE_DIR` (default `build/webcore/bin` of the repository) and `sw.js`/`media-sw.js` of the
core at the root, and forwards `/wisp/` and `/profile/` to `BL_SERVER` (default
`http://localhost:5001`). `tools/package-demo.sh <engine-dir> <out>` builds the folder for
`SITE_DIR` of `browser-lite-server`: the Vite build with `VITE_ENGINE_BASE=engine/<hash>/` and
the engine in `engine/<hash>/`. The engine is never bundled; the core loads it at runtime.

## URL parameters

| Parameter | |
| --- | --- |
| `url` | opens this address instead of the last session |
| `token` | access token, stored per relay host in localStorage (relay and profile of that host) |
| `log=1` | engine log in the console |
| `gpu=0`, `compositing=0`, `safepointgc=0\|debug`, `httpcache=0`, `scripttimeout=<s>`, `fcdebug=<level>` | engine switches for debugging |
| `debug=1` | `browser.debug`, the engine test hooks and `window.blTest` |
| `relay` | only with `debug=1`: another relay for this load, never stored |
| `env` | only with `debug=1`: `KEY=value,...` unchanged as `engine.env` (`BL_*`, `JSC_*`, `FC_*`); `createBrowser` refuses switches the core owns (so `BL_EXTRA_CA` never comes from a link) and the demo shows the error |

An extra CA certificate only comes through code: with `debug=1` a test sets
`window.blTestOptions = { engine: { extraCA } }` before the start, merged into the options of
`createBrowser` like on the core test host page (plain objects key by key, other values replace).

`window.blTest` (with `debug=1`): `browser`, `view()`, `views()`, `open(url)`, `load(url)`,
`eval(source)`, `pagePixel(x, y)`, `pageRow(y)`, `memory(report?)`, `memoryPressure()`,
`memoryLimit(megabytes)` (a limit like in a 32 bit browser), `crash(kind)`, `audioState()`,
`mediaState()`, `rtcState()`, `framesShown()`, `flags` (`firstLayout`,
`firstPaint`, `loaded`), and for the demo `checkMemory()` (discards a background tab, returns the
new view id or 0), `memoryUsed()`, `gpu(action)`, `profile`, `settings()`, `addressToURL(text)`,
`transport`, `relay`, `options`.

## Storage

Settings, bookmarks and permission decisions are prefs of the profile on the server
(`@browser-lite/profile`, so they follow to other devices); history, the session and the access
tokens stay in localStorage of this device. Pages store in the OPFS namespace `browserlite`.

The prefs of the server only arrive in `storage.beforeStart`, after the engine options are fixed:
the engine starts with the settings of the last start on this device, takes changed user agent,
languages, color scheme and page settings right away and starts once more when the time zone,
the emulated device or "Restore tabs at start" changed on another device.

## Modules (src/)

| Module | |
| --- | --- |
| `main.ts` | start: URL parameters to options, `createBrowser`, events, crash and hang, restart in the page |
| `params.ts`, `runtime.ts` | URL parameters, relay and token; the running browser and the profile |
| `tabs.ts` | tabs on views: popups (`new-view`), restored and discarded tabs, closing with beforeunload, memory pressure |
| `toolbar.ts`, `address-bar.ts`, `find-bar.ts`, `zoom.ts`, `print-preview.ts` | toolbar, address bar with suggestions, find bar, zoom steps, print preview |
| `history.ts`, `bookmarks.ts`, `session.ts`, `downloads.ts`, `side-panel.ts` | library and the side panel (menu, history, bookmarks, downloads) |
| `settings.ts`, `settings-page.ts` | settings and what applies at the start; the settings page |
| `dialogs.ts`, `permissions.ts` | native dialogs with background suppression; permission decisions in the profile |
| `shortcuts.ts`, `engine-message.ts`, `view-source.ts`, `reload.ts`, `test-hooks.ts`, `util.ts` | shortcuts, messages over the page area, page source, reloads, `window.blTest`, helpers |
