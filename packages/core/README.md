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
The view puts its canvas (`position: relative`) and a hidden text field into the container; a
playing video goes before the canvas, underneath it (the engine leaves its rect transparent).
After the text field an absolutely positioned layer over the canvas holds the damage tiles the
engine asks for (`view-tiles.ts`): small canvases that show frames which change only a small part
of the page (a spinner), so the host repaints only them and not the whole canvas.
The canvas shows the page's frames pixel for pixel from its top left (its box is the pixel ratio
times the container, scaled back with `transform`), so size the container, not the canvas.
Overlays of your own inside the container need a `z-index`; for the page the mouse leaves when it
moves onto one or out of the canvas (mouseleave, no more `:hover`). The hidden text field takes the
focus for the page and carries the input mode and enter key hint of the page's focused field (a
search field without a hint gets the search key, like in Chrome and Safari), so phones show the
fitting on-screen keyboard; in Chrome the view focuses it once more after a tap
into a field, which opens the keyboard there, on iPhone and iPad when the hint changes, which
gives the keyboard the hint. It keeps the text an input method entered until the caret moves
otherwise, so an on-screen keyboard's Backspace and suggestions after typing reach the page.
On iPhone and iPad two more hidden fields lie right before and after it while it has the focus,
on the top left pixels of the view: the keyboard's previous and next field arrows focus them,
and the view turns that into Shift+Tab or Tab in the page instead of leaving it for your own
fields ([architecture, Input](../../docs/architecture.md#input)).
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
| `extensions` | none | Host of `createExtensionHost()`, see [Extensions](#extensions) |
| `permissions` | in memory | `PermissionStore` with remembered decisions |
| `errorPage` | engine default | HTML template of the error page (placeholders in the engine README) |
| `userAgent`, `platform` | engine default | `navigator.userAgent`, `navigator.platform` |
| `languages` | host languages | `navigator.languages` and Accept-Language |
| `timeZone` | host time zone | IANA name |
| `colorScheme` | `system` | `light`, `dark` or `system` (follows the host) |
| `device` | host screen | `{ width, height, pixelRatio, touch?, mobile? }` emulated device; `browser.setDevice()` changes it at runtime (a rotated phone: the views keep at most the new size, `screen`, `screen.orientation` and its `change` event follow) |
| `maxPixelRatio` | no limit | Highest pixel ratio the pages render at on the host screen (at least 1, `browser.setMaxPixelRatio()` changes it; an emulated `device` keeps its own); above it the host scales the views up, the engine paints fewer pixels |
| `preferences` | all on, GPC and data saver off | `{ javascript, images, globalPrivacyControl, saveData }` (`saveData`: `Save-Data: on` on every request, `navigator.connection.saveData`) |
| `keepSessionCookies` | `false` | Session cookies survive a restart |
| `engine` | | `gpu`, `compositing`, `safepointGC`, `httpCache`, `scriptTimeoutSeconds`, `extraCA` (PEM), `log`, `env` (experimental `BL_*`, `JSC_*`, `FC_*` switches; keys the core sets are rejected) |
| `onProgress` | none | Progress of the start for a loading indicator: `{ phase, loaded, total }`, `download` with the uncompressed bytes of `engine.wasm` and `engine.data` (total from `manifest.json`, 0 when unknown) only when the files do not come from the cache, then `start` |
| `debug` | `false` | Enables `browser.debug` (with `memoryLimit(megabytes)`, a limit of the engine memory like in a 32 bit browser, and `framesShown()`, the frames the engine put on screen) and the engine test hooks; never with foreign scripts on the page |

## Handlers and events

Requests the engine waits for have one handler (`options.handlers`), behind those extensions
put in front of it; everything else is an event (`browser.on`, `view.on`, `download.on`), with
any number of listeners.

| Handler | Default |
|---|---|
| `dialog` | alert ignored, confirm `false`, prompt `null`, beforeunload `true` (leave), resubmit `false` (the form is not sent again, the page stays) |
| `permission` | denied without remembering; grant `notifications` only after the host allowed them (`Notification.requestPermission`). When the page that asked is left (its main frame commits a new document, like Chrome), the question counts as dismissed and its signal aborts |
| `authenticate` | `null`: the page shows the 401 response. Called for a 401 with Basic or Digest of the main frame or a same origin load without stored credentials, with `url`, `origin`, `realm`, `scheme` and `retry` (the last credentials were refused); resolve `{ username, password }` to sign in. The engine keeps them for the session per realm |
| `fileChooser` | native file dialog of the host |
| `selectPopup`, `colorPicker`, `dateTimePicker` | cancel |
| `dataListPopup` | `-1`: no suggestion list. The suggestions of an `<input list>` while the user types (`suggestions` with `value` and `label`, `highlightedIndex`); the field keeps the focus and the keys: Up and Down move the highlight in the engine, which sends a new request (the old signal aborts), Enter takes it, Escape closes. Resolve the index of a clicked entry or `-1` to close |

Every request carries an `AbortSignal` that aborts when the page hides the popup, the view closes,
the engine ends or the page opens the same popup again (the old answer is then ignored); that of
a permission question also when its page is left.

A `dialog` handler may answer with a promise (an own in-page dialog). Like in Chrome only the
asking page waits meanwhile, together with popups it shares script with: it gets no input, its
view runs calls afterwards and shows its last frame. All other views go on. Navigating the view
(`load`, `reload`, `back`, `forward`, `restoreHistory`) first answers its open dialogs with the
default and aborts their signal. A native dialog of the host page (`window.alert`) stops the host
page itself and with it every view. `resubmit` comes before a reload or back/forward would send a
form (POST) again (from the back/forward cache nothing is sent): `true` sends it, otherwise the
page stays. Only that navigation waits, the page runs on; when it navigates or stops meanwhile
the signal aborts. `view.close()` of a page with a beforeunload listener asks it first, but like
Chrome a page that does not answer within 500 ms (it or another view keeps the engine thread busy)
closes without asking; an open beforeunload question waits for its answer.

`view.find(text)` answers with a `find` event per call, in the order of the calls. It carries
the `text` it belongs to, so a find bar shows only the result of its current text, and counts at
most 1000 matches, with `more` when the page has more.

The events are listed with their payloads in `BrowserEvents` and `ViewEvents` of
[src/types.ts](src/types.ts) (a `Download` has `progress`, `done` and `error`). Some only report
what a browser UI has to do, and nothing happens without a listener:

| Event | What the host does |
|---|---|
| `new-view` (browser) | `window.open` or `target=_blank`: the view runs but has no container, so it cannot be seen. `view.attach(element)` it (for example in a new tab), or `view.close()` it |
| `open-tab` | Ctrl/Cmd, middle or Shift click on a link, also one with `target=_blank`: open `url` in a new view as `disposition` says (`background`, `foreground` or `window`, like Chrome), or ignore it |
| `external-url` | `mailto:`, `tel:` and app links: hand `url` to the host, or ignore it |
| `popup-blocked` | A popup without a user gesture did not open (like in Chrome): show that, offer to open `url` and to allow the site with `browser.setPermission(origin, 'popups', 'grant')` |
| `context-menu` | A right click or long press (`touch` true, the menu comes when the finger lifts) the page did not handle: show a menu (`showContextMenu` and `defaultMenuItems` of `@browser-lite/ui`) |
| `unhandled-key` | A keydown into the page (while `view.focused`) that the page did not handle (no `preventDefault`, editing command or default action): run your keyboard shortcut for it, like Chrome, where the page gets Ctrl+F or Ctrl+U first. Call `preventDefault` on the host keydown of such a shortcut and let it through to the view; run the ones the page must never get (Ctrl+T, Ctrl+W) on the host keydown right away |
| `print` | `window.print()` or `view.print()`: show or save the PDF |
| `source` | `view.viewSource()`: show the text |
| `close` | The view is closed (`window.close()` of the page or `view.close()`): remove its UI |
| `memory-pressure` (browser) | The engine memory runs short (`footprint` and `limit` in bytes; the limit is about 1 GB in a 32 bit browser, found at runtime; on iPhone and iPad it comes from 512 MB on, iOS ends the whole page before the memory stops growing): close or discard background views, tell the user when none is left |
| `unresponsive` (browser) | No answer for 10 s after input: offer to wait (`browser.keepWaiting()`, the event comes again 10 s later while it lasts) or to restart; `responsive` when it answers again |
| `crash` (browser) | The engine is gone: destroy the browser and create a new one ([Lifecycle](../../docs/embedding.md#lifecycle)); `reason` is the error with its WebAssembly stack, for a bug report |

Without a `download` listener finished downloads are saved automatically.

A failed navigation comes as `error` with the network layer's English text (`description`, for
logs), then usually the engine's error page commits (`commit` with `errorPage`). Like in Chrome
that page is the message for users; showing `description` as well only repeats it in words they
do not understand.

`view.history` holds the back/forward list with the scroll position of every entry; for the
page shown it follows the `history` event (at most once a second while it scrolls). When the
embedding page goes into the background or away (`visibilitychange`, `pagehide`) the positions
not reported yet arrive as `history` events before it goes, so a session saved from them is
current; `view.close()` does the same for its view before `close`, so a closed tab kept for
reopening has the position of its last second.
`restoreHistory(history)` and `createView({ history })` bring the page back at that position, like
back and forward.

Console messages come as `console` of the view (`ConsoleMessage`: `level`, `message`, `source`,
`line`); those of service workers, which have no view, as `service-worker-console` of the browser
with the worker's script URL as `source`.

`view.load(url)` reads `url` like Chrome's address bar, so pass typed text as it is. Without a
scheme it loads `https://` and, when that fails without an answer of the site (no connection, no
valid TLS), `http://` once the error page has loaded; localhost, IP addresses, names without a dot
and a port other than 80 load over `http://` right away. `typedAddress(text)` returns the address
a load of text starts with ('' for none). An address that is invalid also then (a port above
65535) loads nothing, like in Chrome; check typed text with `typedAddress` first and search for it
instead.

`view.pendingURL` is the address of a navigation the host started (`load`, `back`, `forward`,
`restoreHistory`) until its document commits or the navigation ends (stop, failure, download,
the page stays on its beforeunload question); every `navigation` event carries it. Like Chrome's
address bar, show it instead of `url` meanwhile, so a slow server or a sign in prompt does not
leave the bar on the page being left. Navigations of the page never set it, so a page cannot
make the bar show an address it is not on.

`browser.preconnect(url)` opens the connection to the origin of an http(s) address ahead (TCP
through the transport and TLS), for example while the user types it into an address bar; the
engine does the same for `<link rel=preconnect>` of the pages and for a link the mouse goes down
on.

## Extensions

`createExtensionHost({ app?, store? })` returns the host of an integrator's extensions; pass it as
`extensions` to every browser it should serve (one at a time, it outlives restarts). An extension
is `{ id, version, setup(context) }`; the context offers `onBrowser`, `onView`, `handle(type,
handler)` (request handler chain: extensions in install order, then `options.handlers`, then the
default), `addScript` and `addStyle` (pages by match patterns, scripts in an isolated world per
extension with the global `extension`), `onMessage` and `postMessage`, `storage`, `app` and
`signal`. Host: `install`, `uninstall`, `enable`, `disable`, `extensions`, `on('change')`. Types:
`Extension`, `ExtensionContext`, `ExtensionHost`, `ExtensionHostOptions`, `ExtensionInfo`,
`ExtensionStorage`, `ExtensionStore`, `ChainedHandler`, `ContentScript`, `ContentStyle`,
`MessageSender`, `Disposer`, `SetupResult`. Design and examples:
[docs/extensions.md](../../docs/extensions.md).

## Services

`defaultServices()` is `[audio(), media(), capture(), devices()]`.

- `audio()`: Web Audio through an AudioWorklet (`dist/audio-worklet.js`, export
  `@browser-lite/core/audio-worklet.js`).
- `media({ pictureInPicture })`: `<video>`/`<audio>` through hidden media elements of the host;
  media files need the service worker ([Service worker](../../docs/embedding.md#service-worker)).
  Without it a `warning` event with code `media-sw-missing` follows. In a hidden view a video
  without an audio track pauses like in Chrome, the host element too (it tells the engine which
  media have one). A view gets `picture-in-picture` events when one of its videos enters or leaves that window.
  Picture-in-picture needs the host's `requestPictureInPicture` (not in Firefox): without it the
  pages do not see the API.
- `capture()`: camera, microphone and screen.
- `webrtc()`: opt-in; the connections bypass the transport and reveal the IP of the device.
- `devices({ ... })`: geolocation, sensors, gamepad, speech, notifications, fileSystemAccess,
  clipboard, eyedropper, battery, keyboard, networkInfo, imageDecoder, touch (all on by default).
  The `clipboard` switch covers the `navigator.clipboard` API of the pages; copy and cut in a page
  always reach the clipboard of the host.
  Gamepads are read once per frame only while a page uses them; only then does the core listen
  for `gamepadconnected` on your window ([Resource use](../../docs/embedding.md#resource-use)).

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
