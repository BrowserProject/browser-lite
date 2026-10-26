# @browser-lite/core

Runs the browser-lite engine (WebKit compiled to WebAssembly) inside a web page: browsers,
views, input, storage and host services. No UI: popups, menus and prompts come from request
handlers (unstyled defaults in `@browser-lite/ui`).

## Install

Not on npm yet: install the tarballs of a GitHub release, usually together with
`@browser-lite/transport-wisp` ([README, Install](../../README.md#install)). Host the engine
files of the same release on the same origin as the page.

## Minimal example

```js
import { createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const browser = await createBrowser({
  engineUrl: '/engine/0.1.0/', // one folder per engine version
  transport: new WispTransport({ url: 'wss://example.com/wisp/' }),
  serviceWorker: { url: '/sw.js' }, // needed for <video>/<audio>, see below
});
const view = browser.createView({ container: document.querySelector('#page'), url: 'https://example.com/' });
view.on('title', ({ title }) => console.log(title));
```

The container needs a size (for example `height: 100vh`); the view fills it and follows its size.
`sw.js` and `media-sw.js` are package exports (`@browser-lite/core/sw/sw.js`,
`@browser-lite/core/sw/media-sw.js`), so a build step can resolve and copy them; how to serve
them or load `media-sw.js` into the site's own worker:
[Service worker](../../docs/embedding.md#service-worker).

## Options of createBrowser

| Option | Default | Meaning |
|---|---|---|
| `engineUrl` | required | Folder with the engine files, same origin |
| `transport` | required | Network of the engine (`Transport`, for example `WispTransport`) |
| `storage.persistent` | `true` | `false` keeps everything in memory (no OPFS, no HTTP cache) |
| `storage.namespace` | `browserlite` | OPFS directory and prefix of caches and the Web Lock, `^[a-z0-9_]{1,32}$` |
| `storage.beforeStart` | none | Runs with the namespace directory before the engine starts |
| `serviceWorker` | none | `{ registration }` or `{ url, scope? }` of a worker that loads `media-sw.js`; never registered implicitly |
| `services` | `defaultServices()` | Host services, see below |
| `handlers` | safe defaults | Request handlers, see below |
| `permissions` | in memory | `PermissionStore` with remembered decisions |
| `errorPage` | engine default | HTML template of the error page (placeholders in the engine README) |
| `userAgent`, `platform` | engine default | `navigator.userAgent`, `navigator.platform` |
| `languages` | host languages | `navigator.languages` and Accept-Language |
| `timeZone` | host time zone | IANA name |
| `colorScheme` | `system` | `light`, `dark` or `system` (follows the host) |
| `device` | host screen | `{ width, height, pixelRatio, touch?, mobile? }` emulated device |
| `preferences` | all on, GPC off | `{ javascript, images, globalPrivacyControl }` |
| `keepSessionCookies` | `false` | Session cookies survive a restart |
| `engine` | | `gpu`, `compositing`, `safepointGC`, `httpCache`, `scriptTimeoutSeconds`, `extraCA` (PEM), `log`, `env` (experimental `BL_*`, `JSC_*`, `FC_*` switches; keys the core sets are rejected) |
| `onProgress` | none | Progress of the start for a loading indicator: `{ phase, loaded, total }`, `download` with the uncompressed bytes of `engine.wasm` and `engine.data` (total from `manifest.json`, 0 when unknown) only when the files do not come from the cache, then `start` |
| `debug` | `false` | Enables `browser.debug` (with `memoryLimit(megabytes)`, a limit of the engine memory like in a 32 bit browser, and `framesShown()`, the frames the engine put on screen) and the engine test hooks; never with foreign scripts on the page |

## Handlers and events

Requests the engine waits for have exactly one handler (`options.handlers`); everything else is
an event (`browser.on`, `view.on`, `download.on`), with any number of listeners.

| Handler | Default |
|---|---|
| `dialog` (synchronous) | alert ignored, confirm `false`, prompt `null`, beforeunload `true` (leave) |
| `permission` | denied without remembering; grant `notifications` only after the host allowed them (`Notification.requestPermission`) |
| `fileChooser` | native file dialog of the host |
| `selectPopup`, `colorPicker`, `dateTimePicker` | cancel |

Every request carries an `AbortSignal` that aborts when the page hides the popup, the view closes,
the engine ends or the page opens the same popup again (the old answer is then ignored).

The events are listed with their payloads in `BrowserEvents` and `ViewEvents` of
[src/types.ts](src/types.ts) (a `Download` has `progress`, `done` and `error`). Some only report
what a browser UI has to do, and nothing happens without a listener:

| Event | What the host does |
|---|---|
| `new-view` (browser) | `window.open` or `target=_blank`: the view runs but has no container, so it cannot be seen. `view.attach(element)` it (for example in a new tab), or `view.close()` it |
| `open-tab` | Ctrl or middle click on a link: open `url` in a new view, or ignore it |
| `external-url` | `mailto:`, `tel:` and app links: hand `url` to the host, or ignore it |
| `context-menu` | Show a menu (`showContextMenu` and `defaultMenuItems` of `@browser-lite/ui`) |
| `print` | `window.print()` or `view.print()`: show or save the PDF |
| `source` | `view.viewSource()`: show the text |
| `close` | The view is closed (`window.close()` of the page or `view.close()`): remove its UI |
| `memory-pressure` (browser) | The engine memory runs short (`footprint` and `limit` in bytes; the limit is about 1 GB in a 32 bit browser, found at runtime): close or discard background views, tell the user when none is left |
| `crash` (browser) | The engine is gone: destroy the browser and create a new one ([Lifecycle](../../docs/embedding.md#lifecycle)); `reason` is the error with its WebAssembly stack, for a bug report |

Without a `download` listener finished downloads are saved automatically.

## Services

`defaultServices()` is `[audio(), media(), capture(), devices()]`.

- `audio()`: Web Audio through an AudioWorklet (`dist/audio-worklet.js`, export
  `@browser-lite/core/audio-worklet.js`).
- `media({ pictureInPicture })`: `<video>`/`<audio>` through hidden media elements of the host;
  media files need the service worker ([Service worker](../../docs/embedding.md#service-worker)).
  Without it a `warning` event with code `media-sw-missing` follows.
  A view gets `picture-in-picture` events when one of its videos enters or leaves that window.
- `capture()`: camera, microphone and screen.
- `webrtc()`: opt-in; the connections bypass the transport and reveal the IP of the device.
- `devices({ ... })`: geolocation, sensors, gamepad, speech, notifications, fileSystemAccess,
  clipboard, eyedropper, battery, keyboard, networkInfo, imageDecoder, touch (all on by default).
  The `clipboard` switch covers the `navigator.clipboard` API of the pages; copy and cut in a page
  always reach the clipboard of the host.

A feature without its service is missing for the pages, like in a browser without it.

## Errors

`createBrowser` and friends throw `BrowserLiteError` with `code`:
`unsupported` (`missing` lists the host features), `not-cross-origin-isolated`,
`engine-load-failed`, `already-running` (one browser per page; destroy it before creating the
next), `invalid-options`, `storage-locked` (`clearStorage` while in use), `destroyed`, `crashed`.

## Hosting

Cross-origin isolation (`checkSupport()` tells what is missing), engine files, service worker,
CSP, relay, storage and lifecycle: [docs/embedding.md](../../docs/embedding.md); before
production: [docs/security.md](../../docs/security.md).
