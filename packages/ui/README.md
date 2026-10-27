# @browser-lite/ui

Unstyled default UI for browser-lite: the select popup, color and date/time pickers, the
permission prompt, Chrome-like native dialogs, the context menu and the link status bubble.
The elements carry class names and `data-bl-*` attributes; only position and size are set
inline, the page styles the rest.

Not on npm yet: install the tarballs of a GitHub release together with `@browser-lite/core`
([README, Install](../../README.md#install)).

## Example

```js
import { createBrowser } from '@browser-lite/core';
import { defaultHandlers, defaultMenuItems, linkStatus, showContextMenu } from '@browser-lite/ui';

const browser = await createBrowser({ engineUrl, transport, handlers: defaultHandlers() });
const view = browser.createView({ url: 'https://example.com/', container });

view.on('context-menu', (info) => {
  // A tabbed UI would create a view with its own container instead
  const items = defaultMenuItems(view, info, { openTab: (url) => view.load(url) });
  showContextMenu(view, info, items);
});
const removeStatus = linkStatus(view);
```

## API

| Export | Purpose |
| --- | --- |
| `defaultHandlers(o?)` | All handlers below as `Partial<RequestHandlers>` (file chooser stays with the core). |
| `selectPopup(o?)` | `<select>` list below or above the field. Keys: arrows, PageUp/PageDown, Home/End, typing jumps, Enter/Space choose, Escape/Tab cancel. Click outside, resize or window blur cancel. |
| `colorPicker(o?)`, `dateTimePicker(o?)` | Native pickers of the host browser through a hidden input (`showPicker()`), with min, max and step of the field. Every `input` event previews the value in the page (`request.preview`); resolve on change or on a click elsewhere. One picker per document, also when composed separately: a new one finishes the open one. |
| `permissionPrompt(o?)` | "example.com wants to know your location" with Block and Allow; one at a time, queued. Only asks: remembering is the job of the `PermissionStore`. Allowing notifications also asks the host browser. |
| `nativeDialogs(o?)` | `alert`, `confirm`, `prompt` with "example.com says:", `beforeunload` as "Leave site?" or "Reload site?" with the standard sentence. A page showing dialogs in a fast loop is asked about once (`onBlocked(view)` when the user blocks); blocking lasts until the next document. |
| `showContextMenu(view, info, items, o?)` | Renders a menu at the position of a `context-menu` event; returns a close function. Escape, a click outside, window blur or closing the view close it. |
| `defaultMenuItems(view, info, actions, o?)` | The standard items: open and copy link or image, copy, cut, paste, select all, back, forward, reload, print, view source. `actions.openTab(url)` is required; `reload`, `print`, `viewSource`, `copyText`, `readText` are optional overrides. |
| `linkStatus(view, o?)` | Bubble with the URL under the mouse; returns a function that removes it. |
| `defaultTexts`, `UiTexts` | English texts. |

Every handler honours `request.signal`: an aborted request removes its element and resolves the
default answer (-1, null or 'deny'), which the core ignores.

`UiOptions`: `root` (element the ui is appended to, default `document.body`) and `texts`
(partial `UiTexts`; templates use `{host}` and `{kind}`).

```js
const handlers = defaultHandlers({ texts: { allow: 'Erlauben', block: 'Blockieren' } });
```

`nativeDialogs` uses the blocking dialogs of the host browser, so the host page and every view
wait until the user answers (an own in-page dialog returning a promise only holds the asking
page). To suppress dialogs of background views, wrap the handler:

```js
const { dialog } = nativeDialogs({ onBlocked: (view) => markBlocked(view) });
const handlers = {
  ...defaultHandlers(),
  dialog(r) {
    if (r.view === activeView) return dialog(r);
    if (r.type === 'beforeunload') return true;
    return r.type === 'prompt' ? null : false;
  },
};
```

While a select popup or context menu is open, it takes key events in the capture phase of the
window, so the page does not get them; the listeners are removed when it closes. A keydown
listener of the embedding page in the capture phase of the window that was added earlier still
runs first: register shortcut handlers in the bubble phase, or skip them while
`.bl-select-popup` or `.bl-context-menu` is in the DOM.

## Elements

| Selector | Notes |
| --- | --- |
| `.bl-select-popup` | `role=listbox`, `data-bl-view`; rows `.bl-option` (`data-bl-index`, `data-bl-highlighted` and `.bl-highlighted`, `aria-selected`, `aria-disabled`), `.bl-group`, `hr.bl-separator`. Inline: `position: fixed`, `top`, `left`, `min-width`, `max-height`, `overflow-y: auto`. |
| `input.bl-host-picker` | Hidden field at the place of the page field (inline `opacity: 0`, `pointer-events: none`). |
| `.bl-permission-prompt` | `role=dialog`, `data-bl-view`, `data-bl-kind`; `p`, `button.bl-block`, `button.bl-allow` (`data-bl-answer`). Not positioned. |
| `.bl-context-menu` | `role=menu`, `data-bl-view`; `button.bl-menu-item` (`data-bl-item`, `disabled`), `hr.bl-separator`. Inline: `position: fixed`, `left`, `top`. |
| `.bl-link-status` | `data-bl-view`, `hidden` without a link. Not positioned. |

Every element also has `data-bl-ui` with its name (for example `data-bl-ui="select-popup"`).

## Tests

`npm test` runs the unit tests in Node against `dist/` (build first with `npx tsc -b` at the
repository root). `node test/browser.mjs` runs the DOM tests in headless Chromium (playwright of
the workspace); CI runs them with `node tests/run.mjs packages`.
