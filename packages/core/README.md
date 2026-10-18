# @browser-lite/core

Runs the browser-lite engine (WebKit compiled to WebAssembly) inside a web page: browsers,
views, input, storage and host services. No UI: popups, menus and prompts come from request
handlers (unstyled defaults in `@browser-lite/ui`).

## Install

```bash
npm install @browser-lite/core @browser-lite/transport-wisp
```

Host the engine files (`engine.js`, `engine.wasm`, `engine.data`) on the same origin as the page.

## Minimal example

```js
import { createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const browser = await createBrowser({
  engineUrl: '/engine/',
  transport: new WispTransport({ url: 'wss://example.com/wisp/' }),
  serviceWorker: { url: '/sw.js' }, // needed for <video>/<audio>, see below
});
const view = browser.createView({ container: document.querySelector('#page'), url: 'https://example.com/' });
view.on('title', ({ title }) => console.log(title));
```

The container needs a size (for example `height: 100vh`); the view fills it and follows its size.
For the service worker copy `dist/sw/sw.js` and `dist/sw/media-sw.js` into the same folder
(`sw.js` loads `media-sw.js` next to itself).

## Options of createBrowser

| Option | Default | Meaning |
|---|---|---|
| `engineUrl` | required | Folder with the engine files, same origin |
| `transport` | required | Network of the engine (`Transport`, for example `WispTransport`) |
| `storage.persistent` | `true` | `false` keeps everything in memory (no OPFS, no HTTP or bytecode cache) |
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
| `debug` | `false` | Enables `browser.debug` and the engine test hooks; never with foreign scripts on the page |

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
the engine ends or the page opens the same popup again (the old answer is then ignored). Without a `download` listener finished downloads are saved automatically.

## Services

`defaultServices()` is `[audio(), media(), capture(), devices()]`.

- `audio()`: Web Audio through an AudioWorklet (`dist/audio-worklet.js`).
- `media({ pictureInPicture })`: `<video>`/`<audio>` through hidden media elements of the host;
  media files need the service worker: the standalone `dist/sw/sw.js` together with
  `dist/sw/media-sw.js` in the same folder, or `importScripts('media-sw.js')` in a worker of
  the site.
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
`engine-load-failed`, `already-running` (one browser per page; destroy it before creating the next), `invalid-options`, `storage-locked`
(`clearStorage` while in use), `destroyed`, `crashed`.

## Hosting requirements

- The page is cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (`checkSupport()` tells what is missing).
- Engine files and `audio-worklet.js` on the same origin; never bundle `engine.js`.
- For media files a service worker whose scope covers the page and which loads `media-sw.js`.
- One running browser per storage namespace across the tabs of the origin (Web Lock); a second
  tab keeps its data in memory (the HTTP and bytecode caches stay shared) and gets the warning
  `storage-locked`.

Embedding modes, headers, CSP, relay, storage and lifecycle in detail:
[docs/embedding.md](../../docs/embedding.md); before production: [docs/security.md](../../docs/security.md).
