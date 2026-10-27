# Extensions

A plugin system for integrators and the browser built on browser-lite: an extension is a plain
object that adds request handlers, scripts and CSS for pages, data and UI. Not Chrome
WebExtensions; a compatibility layer could sit on top later. Decisions #280 to #282 in
[decisions.md](decisions.md).

## Where it lives

| Part | Package | |
|---|---|---|
| Host, context, request handler chain, page content, messages, storage | `@browser-lite/core` (`src/extensions/`) | `createExtensionHost`, `BrowserOptions.extensions` |
| UI slots: toolbar buttons, side panels, context menu entries, settings sections | `@browser-lite/ui` (`src/slots.ts`) | `createUiSlots`, `renderToolbar`, `slotMenuItems` |
| Scripts and CSS in pages, isolated worlds, the `extension` bridge | engine (`engine/src/UserContent.cpp`) | `bl_set_user_content`, `bl_extension_message`, event `extension-message` |
| Rendering of the slots, switches, data in the profile | `apps/demo` (`src/extensions.ts`) | an integrator's own choice |

No new package: the host needs the internals of the browser (handlers, engine exports), the slots
are plain DOM like the rest of the ui package.

## Extension and lifecycle

```js
const hello = {
  id: 'hello',            // ^[a-z0-9][a-z0-9._-]{0,63}$: storage and isolated world
  version: '1.0.0',
  setup(context) {        // at every enable; may be async
    context.addStyle({ matches: ['https://*.example.com/*'], code: 'body { outline: 2px solid red }' });
    return () => {};      // optional disposers; everything registered through context ends anyway
  },
};
const extensions = createExtensionHost({ app: { ui }, store });
await extensions.install(hello);                      // before or after createBrowser
const browser = await createBrowser({ ..., extensions });
```

- The host is independent of a browser and serves one browser at a time: it attaches when the
  browser is ready (before its first view) and detaches when it is destroyed or crashes, so the
  extensions survive a restart.
- `install(ext, { enabled })`, `enable(id)`, `disable(id)`, `uninstall(id)`, `extensions`
  (`{id, version, enabled, error}`) and the event `change`. Setup runs once per enable, not per
  browser. A failing setup leaves the extension disabled with `error`; its registrations are undone.
- Disable undoes in reverse order: view and browser hooks, returned disposers, handlers, page
  content (its CSS leaves open pages at once, scripts stay in documents that already ran them).
- Order: extensions in the order of installation.

## Context

| Member | |
|---|---|
| `id`, `app`, `signal` | `app` is what the integrator offers (the demo: `{ ui }`), `signal` aborts at disable |
| `browser`, `onBrowser(setup)`, `onView(setup)` | the attached browser; setups for every browser and every view, their disposers run when the browser ends, the view closes or at disable. Navigation and the other view events come from `view.on` |
| `handle(type, handler)` | joins the chain of a request handler (below) |
| `addScript(script)`, `addStyle(style)` | page content (below) |
| `onMessage(listener)`, `postMessage(view, message)` | messages with the isolated scripts of this extension, JSON values |
| `storage` | `get`, `set`, `delete`, `keys`: synchronous, JSON values, saved through the `store` of the host after every change (default in memory). For settings and small state; large data (filter lists) belongs into the Cache API or OPFS of the integrator's origin |

### Request handler chain

`handle('dialog', (request, next) => ...)`: every request type of `RequestHandlers` is a chain.
Handlers of the extensions run in the order of installation, then the handler of
`BrowserOptions.handlers`, then the default. A handler answers itself or returns `next()` (and may
look at or change its answer). Without extension handlers a request goes straight to the handler
of the options as before.

### Page content

| Field | |
|---|---|
| `matches`, `excludeMatches` | `scheme://host/path`: `*` as scheme is http and https, as host or its first label (`*.example.com`) any; `*` anywhere in the path; no port; `<all_urls>` |
| `code` | JavaScript or CSS source |
| `runAt` (scripts) | `document-start` (before the page's scripts) or `document-end` (default, parsed) |
| `allFrames` | also frames; default only the main frame |
| `world` (scripts) | `isolated` (default) or `main` (the page's own world, for example to replace page APIs) |

The engine uses WebCore's `UserContentController` like WebKitLegacy: scripts are `UserScript`s,
CSS are user style sheets (their `!important` wins over the page). An isolated script runs in a
`DOMWrapperWorld` of the extension: the same DOM, its own globals, invisible to the page and to
other extensions, plus the global `extension`:

```js
const answer = await extension.sendMessage({ kind: 'form', origin: location.origin });
extension.onMessage.addListener((message) => fill(message));
```

`sendMessage` reaches `context.onMessage` (the first listener that returns something other than
undefined answers, a thrown error rejects), `context.postMessage(view, message)` every frame of
the view where a script of the extension ran. Scripts run from the next document on (like Chrome
after installing), CSS applies to open documents too.

## UI slots

`createUiSlots()` of `@browser-lite/ui` is a registry the app renders; extensions get it through
`app`. `add(slot, item)` returns the function that removes the item (return it from setup).

| Slot | Item | Rendered by |
|---|---|---|
| `toolbar` | `{ id, label, icon?, action(view) }` | `renderToolbar(slots, container, activeView)` (`button.bl-toolbar-button`) |
| `context-menu` | `{ id, label, when?(info), action(view, info) }` | `slotMenuItems(slots, view, info)` after `defaultMenuItems` |
| `panel` | `{ id, title, render(container) }` | the app's side panel; `slots.openPanel(id)` asks to show it |
| `settings` | `{ id, title, render(container) }` | the app's settings page |

The demo renders all four, lists the installed extensions under Settings, Extensions with a
switch each and keeps their data and switches in the profile pref `extensions`.

## Cost without extensions

Nothing of it runs while no extension is installed: no engine call (the pages keep WebCore's
empty user content provider until the first content arrives, `bl_set_user_content` is only sent
when the content changed), no download, no extra work per request (a handler chain exists only
for request types an extension handles). An integrator that does not import `createExtensionHost`
does not bundle the host: the core of such an integrator grows by 0.5 KB with gzip (29.1 to
29.7 KB, `createBrowser` and the default services, minified); the host adds 2.2 KB.

## Future add-ons

| Add-on | Uses now | Needs later |
|---|---|---|
| Accessibility | a script or `onView` for focus and navigation, `panel` or a hidden DOM over the canvas from the integrator's page | an engine export of WebCore's accessibility tree (`AXObjectCache`) per view, delivered to the extension (for example `context.onView` plus a new view event), mirrored as hidden ARIA DOM over the canvas |
| Password manager | an isolated script finds login forms and asks with `sendMessage`, `postMessage` fills; `toolbar` and `panel` for the vault; `storage` or its own encrypted store; `handle('authenticate', ...)` answers HTTP sign-ins from the vault | nothing |
| Ad blocker | `addStyle` for cosmetic filters, `addScript` with `world: 'main'` at `document-start` for scriptlets | blocking requests: WebCore's content extensions (`ENABLE_CONTENT_EXTENSIONS`, Safari's rule lists compiled to a DFA; off in our build) or a URL filter in `LoaderStrategy.cpp`; either is one engine export taking the rules |
| Custom UI | `toolbar`, `panel`, `context-menu`, `settings`; scripts with their own shadow DOM in pages | nothing |
