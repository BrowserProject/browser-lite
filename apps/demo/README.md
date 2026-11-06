# apps/demo/

The full demo browser on browser-lite: tabs (with popups, restored tabs that load on the first
click, discarding under memory pressure and a message when none is left: close tabs while a
loaded background tab stays, else that the page uses the memory), a new tab page,
address bar with suggestions, history, bookmarks, downloads panel, dialogs of the pages in the page, settings page with profile, extensions and device
emulation, find bar, zoom, print preview, keyboard shortcuts, security indicator, pop-up blocker
icon (open a blocked popup, always allow the site), crash and hang
handling, a progress bar while the engine downloads (an address typed meanwhile opens once it
runs), and a phone layout. Built with Vite and only the public APIs of `@browser-lite/core`, `@browser-lite/ui`,
`@browser-lite/profile` and `@browser-lite/transport-wisp`. Deployment on the public server:
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
| `url` | opens this address instead of the last session, read like text typed into the address bar |
| `token` | access token, stored per relay host in localStorage (relay and profile of that host) and removed from the address; when the relay refuses the stored one (missing or old), the demo asks for the access code instead of showing lost connections (`access.ts`, #344) |
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
`firstPaint`, `loaded`), and for the demo `extensions`, `installExtension(extension)`, `ui` (the
slots), `checkMemory()` (discards a background tab, returns the
new view id or 0), `memoryUsed()`, `gpu(action)`, `profile`, `settings()`, `addressToURL(text)`,
`transport`, `relay`, `options`.

## Look and behaviour

Vanilla TypeScript and one style sheet in the visual language of Material 3 (#345). Its design
tokens at the top are the only place for colors (tonal surfaces, the blue accent, light and dark
mode), the type scale of the system fonts (no font download), spacing, radii, three shadow levels
and motion. Every button draws a state layer of `currentColor` (8% hover, 12% pressed) over its
own color, the icons are inline SVG of `icons.ts` (`currentColor`, one stroke width), hover styles
only apply where the pointer can hover (`@media (hover: hover)`, a tap leaves no grey circle),
keyboard focus shows a ring (`:focus-visible`), and tabs, menus, sheets and dialogs appear with
short transitions that `prefers-reduced-motion` turns off. No `backdrop-filter` and no animated
shadows, for weak phones. The base rules set what Safari 18's own style sheet sets differently
from the other browsers, so the layout does not depend on it: buttons stretch their content like
in Chrome (`align-items: normal`; Safari 18 aligns it at the start, which shrank the preview of
the tab overview cards to the icon, #378). The styles of `@browser-lite/ui` (prompts, dialogs, context menu,
select popup) are in the same sheet.

- **Address bar**: the first click or tap selects the whole address, Escape restores it and
  goes back to the page (like Chrome the first Escape after choosing a row with the arrow keys
  only returns to the typed text), the lock or "Not secure" hides while editing. Like Chrome
  every tab keeps an unfinished edit and whether the field had the keyboard across a tab switch,
  an edit stays when the field loses the keyboard until the tab goes to another address, and
  after Enter the field shows the tab's address (a `javascript:` address leaves the page's, #439;
  the phone layout ends an edit with the keyboard). An address that is still
  loading (a slow server, a sign in prompt) stays in the bar and names a tab without a title
  until its page commits, without the indicator of the page being left; Stop goes back to the
  page's address (the view's `pendingURL`, #382). The suggestions start
  with what Enter does (open the typed address, `Search Bing for "weather"`; Bing is the default search, #343; like Chrome
  an invalid address such as a port above 65535 is a search, #407), then bookmarks
  and history with their icons; the arrow keys move. Like Chrome a bookmarked or visited site
  whose host starts with the typed text completes it inline (`githu` shows `github.com` with
  `b.com` selected, the first row; Enter opens it with the scheme it was visited with, typing
  goes on over it, Backspace removes it; text with a path completes nothing), Alt+Enter opens
  the address in a new tab in front and Ctrl+Enter makes a name without a dot a `.com` site
  (`wikipedia` opens `www.wikipedia.com`, #420). A typed address without a scheme goes to
  the core as typed, which loads it like Chrome: `https://` with a fallback to `http://`,
  localhost, IP addresses and ports over `http://` (#435). The address and the find text are also
  the fields' default values, so they stay when Safari brings the demo back from its page cache
  (#422).
- **Find bar** (Ctrl+F): Enter and Shift+Enter in the field and the up and down buttons go to
  the next and previous match, F3 and Ctrl+G too; Escape closes it from anywhere in the bar, also
  after a click on a button took the focus (#376). Like Chrome each tab has its own: switching
  tabs shows the bar of the tab with its text and result or none, and a new document in the tab
  (a navigation or reload) closes it (#390).
- **Keyboard shortcuts** (`shortcuts.ts`): like Chrome the page of the focused tab gets them
  first and they run only when it does not handle the key (`unhandled-key` of the core), so an
  editor keeps its own Ctrl+F, Ctrl+L or Ctrl+P and Ctrl+U underlines in rich text. Only the ones
  that leave or switch the tab (Ctrl+T, Ctrl+Shift+T, Ctrl+W, Ctrl+Tab, Ctrl+PageUp and PageDown)
  and the Alt ones (Alt+Left, Alt+Right, Alt+D) never reach the page (#436). Escape stops a
  loading page like Chrome's Stop, but only when nothing else takes the key: not the page
  (closing its own dialog), the address bar (restores the address) or the find bar (#437).
- **Failed navigations**: like Chrome the engine's error page is the only message; the status
  line and the phone layout's message stay empty instead of repeating it with the network
  layer's text (#427).
- **New tab**: a new tab without a home page shows the new tab page of the demo over its blank
  view (no request to the engine): a greeting by the time of day, a search field that hands over
  to the address bar and tiles of the sites visited most often (the site's icon, else its first
  letter on a color of its host). The tab is called "New tab".
- **Menu**: a dropdown under its button (arrow keys move), with "Profile and site data" and
  Settings at the end; history, bookmarks and downloads open as a floating panel at the right of
  the page, below the toolbar. History goes by day with the time of a visit, a page once per day.
- **Settings**: a navigation with icons (chips on narrow screens) and the settings as cards of
  rows, switches for on and off; start, errors and the access code are a card over the page. On
  narrow screens the whole sheet scrolls and the close button sticks to its top (#379).
- **Tabs**: tabs share the width of the strip down to a minimum, then it scrolls; narrow tabs
  show the cross only on the active (and hovered) tab, on touch screens a little earlier. A tab
  and the window are named after the page's title, without one after its address (#367).
  Ctrl/Cmd+click, middle click (also on a `target=_blank` link) and Open link or image in new
  tab of the context menu open a background tab like Chrome; in the phone layout a message
  offers to switch to it (#391). Like Chrome a tab opened from a link goes right after its page:
  in the background after the tabs that page opened before, so they keep the order of the
  clicks, in front (`target=_blank`, `window.open`) directly after it; an address loaded from
  the address bar or a panel starts over next to the page (`openedBy`, #416). Shift+click and
  Ctrl/Cmd+Shift+click open the link in front directly after its page; Chrome opens a window
  for Shift+click, the demo has none (#438).
  Ctrl+Shift+T (Cmd+Shift+T) brings the tab closed last back at its place with back and forward,
  like Chrome: the last 25 closed by the user or by `window.close()`, not discarded ones or new
  tab pages, only in this page and cleared with the history (`closed-tabs.ts`, #377).
  A discarded tab, a reopened one and the tabs of a restored session come back at the scroll
  position of their page like in Chrome (`scrollX`/`scrollY` of the history entries, #440).
  Dragging a tab with the mouse or a pen moves it along the strip like in Chrome and Firefox
  (`tab-drag.ts`): past 5 px it follows the pointer, takes the place of a neighbour once it
  covers half of it and slides into its place when released; a click only activates, the cross
  never drags, a finger keeps scrolling the strip. Ctrl+Shift+PageUp and PageDown move the
  active tab; the session keeps the order (#383). Closing the active tab activates the tab it
  was opened from in front (Ctrl+T, a link or a popup) as long as no other tab was active in
  between, else its right neighbour, the left one at the end, like Chrome and Firefox (#410).
  A middle click on a tab closes it (through beforeunload like its cross) without activating
  it; only the left button activates a tab, like Chrome and Firefox (#418).
- **Host back and forward**: the back of the host browser (its button, the iOS edge swipe, the
  Android back gesture) goes back in the tab in front while it has a back entry, only then the
  host leaves the demo; its forward goes forward in the tab after a back to the tab's first
  entry (the demo's own forward button always does). `host-history.ts`
  keeps two host entries of the demo, the one it loaded at and one above it that the first user
  action pushes, and moves between them with `history.back()` and `history.forward()` (#414).
  Before the first user action (a restored session) the host back still leaves the demo: Chrome
  and Safari skip host entries a page added without one.
- **Dialogs**: alert, confirm, prompt, beforeunload and the question before a form is sent again
  (reload or back/forward of a POST result, #369) are dialogs of `@browser-lite/ui` over the
  page area, only the tab in front shows them (#338, #149); dialogs, permission prompts and
  sign-in dialogs of a tab behind are hidden until it is in front. Escape dismisses the
  permission prompt. Declining buttons come before accepting ones everywhere.
- **Zoom**: per site like Chrome (`zoom.ts`): Ctrl +/-, Ctrl + mouse wheel and Ctrl+0 change
  the zoom of the host (the host name of an http(s) address, without the port) in all its tabs; a
  tab that shows another host gets that host's zoom, else the default zoom of the settings. The
  zoom of a page without a host (new tab page, `data:`, `file:`) stays with its tab. The zoom
  applies when the new page has committed, so its first layout can still have the old one (#385).
- **Icons of sites**: the tab shows the icon the engine reports for every page once it has
  loaded; until then the last one stays within the site, it goes when the tab leaves the site. `favicons.ts` keeps a 32 px copy per host in localStorage (at most 120, cleared with the
  history) for suggestions, history, bookmarks, the new tab page and the tab overview, drawn
  on a CPU canvas (`willReadFrequently`, see [embedding](../../docs/embedding.md#resource-use)).

## Phone layout

Below 640 px of width or 500 px of height (a phone in portrait or landscape) `style.css` switches
to a layout like mobile Chrome with the address bar at the bottom (#345): the toolbar at the
bottom has back, the address, the tab count and the menu, and the page fills the room above it
from the status bar; forward, reload and the star move into a row of tonal buttons with labels at
the top of the menu (so the empty bookmarks sheet names the Bookmark button there, #428); the address shows only the host until it is tapped, then it takes the whole
bar; the suggestions span the width and open upwards above the toolbar; the tab count opens the
tab overview (a card per tab with title, the site's icon and host: tap to switch, cross to close,
new tab and Done at the bottom); menu, panels and the permission prompt are bottom sheets on the
toolbar over a backdrop, as high as the visible part at most and scrolling (in landscape the menu
has two columns and the toolbar is 44 px high); the find bar sits at the bottom of the page; JS dialogs are centered and the
sign-in dialog at the top; touch targets are at least 44 px and fields have 16 px text (iOS zooms
into smaller). The page uses `viewport-fit=cover` and keeps toolbar, page and sheets out of the
notch and the home indicator (`env(safe-area-inset-*)`). While the iOS keyboard covers the page,
`visual-viewport.ts` sets `--visible-height` and `--keyboard-height`: the page gets as high as the
visible part, so the toolbar sits on the keyboard (without the inset of the home indicator), and
sheets and suggestions stay above it (`--chrome-height` of `main.ts` is the height of the toolbar;
on Android the keyboard makes the page smaller anyway). Like Chrome only a field in the page area
(a page's field, the find bar) makes the page smaller: while a field of the demo has the focus
(address bar, panels, dialogs) the page area keeps the height it had and the keyboard covers its
bottom, so the page is not laid out again when the keyboard opens and closes (`page-size.ts`; a
rotation gives the size free). An emulated device of the
settings fills the page area there. The page is `100dvh` high, so it fills the screen also while
the toolbar of the mobile browser is hidden. On an iPhone, iPad or Android device the setting
"Device" defaults to that device (an Android phone or tablet to the iPhone or iPad: sites refuse
a WebKit user agent with "Android" as the old Android browser, #332) with the real screen of the
host; the Android presets stay in the settings; then the page area keeps the whole
window (only a device the host is not gets a frame of its size). Rotating the phone or tablet rotates the engine's screen too when the device is the host itself (`rotation.ts`, `Browser.setDevice`, #336): pages lay out again for landscape and get `screen.orientation`'s `change` event. Everything is CSS plus the tab overview and the host in the address bar; the media query of
`style.css` is the only breakpoint (`layout.ts` reads it through `--layout`).
`tests/demo/mobile-test.mjs` checks it on an emulated phone.

## Storage

Settings, bookmarks, permission decisions, the zoom per site (pref `site-zoom`, only hosts off the
default zoom) and the extensions' data are prefs of the profile on the server
(`@browser-lite/profile`, so they follow to other devices; "Delete site data" also clears the
permissions and the zoom per site); history, the session and the access
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
| `host-history.ts` | the back and forward of the host browser act on the tab in front |
| `tab-drag.ts` | reordering tabs by dragging them in the strip |
| `tab-overview.ts`, `layout.ts`, `visual-viewport.ts`, `page-size.ts` | tab overview and tab count of the phone layout; whether it applies; following the iOS keyboard; the page keeps its size under the keyboard of the demo's own fields |
| `new-tab-page.ts`, `icons.ts`, `favicons.ts` | the new tab page (greeting, search, site tiles); the SVG icons; icons of the visited sites |
| `blocked-popups.ts` | icon of the address bar for popups the page could not open (`popup-blocked`), its bubble opens one in a new tab or allows popups for the site (permission `popups`) |
| `toolbar.ts`, `address-bar.ts`, `find-bar.ts`, `zoom.ts`, `print-preview.ts` | toolbar, address bar with suggestions (connects to the first one or the typed address while typing), find bar, zoom steps and zoom per site, print preview (the engine's PDF in a frame; where the host shows no PDF in a frame, `navigator.pdfViewerEnabled` false like Chrome on Android, a hint and Save as PDF) |
| `history.ts`, `bookmarks.ts`, `session.ts`, `closed-tabs.ts`, `downloads.ts`, `side-panel.ts` | library, the closed tabs for Ctrl+Shift+T, the menu and the side panel (history, bookmarks, downloads) |
| `settings.ts`, `settings-page.ts` | settings and what applies at the start; the settings page |
| `extensions.ts` | extension host with the UI slots as `app` (toolbar, side panel, context menu, settings), built-in extensions (none yet), switches and data in the profile pref `extensions` ([docs/extensions.md](../../docs/extensions.md)) |
| `dialogs.ts`, `prompts.ts`, `permissions.ts` | dialogs of the pages in the page with background suppression; prompts only of the tab in front; permission decisions in the profile |
| `shortcuts.ts`, `engine-message.ts`, `view-source.ts`, `reload.ts`, `test-hooks.ts`, `util.ts` | shortcuts, messages over the page area, page source, reloads, `window.blTest`, helpers |
