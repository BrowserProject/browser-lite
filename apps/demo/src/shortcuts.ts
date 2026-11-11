import { focusAddress } from './address-bar.js';
import { toggleBookmark } from './bookmarks.js';
import { findAgain, openFind } from './find-bar.js';
import { closePreview, previewOpen } from './print-preview.js';
import { runtime } from './runtime.js';
import { settingsOpen } from './settings-page.js';
import { panelOpen, togglePanel } from './side-panel.js';
import { overviewOpen, toggleOverview } from './tab-overview.js';
import {
  activate,
  activeTab,
  allTabs,
  moveTab,
  onTabCreated,
  openURL,
  printTab,
  reopenClosedTab,
  requestClose,
  switchTab,
} from './tabs.js';
import { changeZoom } from './zoom.js';

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>;

/**
 * A shortcut: its action, `reserved` when the page never gets the key, `last` when also the
 * demo's fields and bars get it first (Escape restores the address, closes the find bar).
 */
interface Shortcut {
  run: () => void;
  reserved: boolean;
  last: boolean;
}

// Like Chrome, which reserves only the shortcuts that leave or switch the tab (Ctrl+T/W/N/Tab,
// Ctrl+PageUp/PageDown; it passes them to pages only in an app window). The others reach the page
// first when it has the focus and run only when it does not handle the key (`unhandled-key`):
// Ctrl+F in an editor with its own find, Ctrl+U in a rich text field. Keys typed until then wait
// in the core and go to the address or find bar the shortcut focused. Alt combinations stay the
// browser's: the engine would type the letter of Alt+D into a field, as it cannot tell Alt+D on
// Linux and Windows from an Option character on macOS.
function shortcut(e: Key): Shortcut | null {
  // The settings are modal (Esc closes them itself)
  if (settingsOpen()) return null;
  const run = shortcutAction(e);
  if (!run) {
    const stop = stopAction(e);
    return stop && { run: stop, reserved: false, last: true };
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const reserved =
    e.altKey ||
    (ctrl &&
      (['t', 'w', 'Tab'].includes(keyName(e)) ||
        (!e.shiftKey && ['PageUp', 'PageDown'].includes(e.key))));
  return { run, reserved, last: false };
}

// Escape is Stop like in Chrome, when nothing else takes the key
function stopAction(e: Key): (() => void) | null {
  const tab = activeTab();
  if (e.key !== 'Escape' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !tab?.loading)
    return null;
  return () => tab.view.stop();
}

const keyName = (e: Key) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

function shortcutAction(e: Key): (() => void) | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = keyName(e);
  const tab = activeTab();
  if (key === 'Escape' && previewOpen()) return closePreview;
  if (ctrl && e.shiftKey && key === 'o') return () => togglePanel('bookmarks');
  if (key === 'Escape' && panelOpen()) return () => togglePanel(null);
  if (key === 'Escape' && overviewOpen()) return () => toggleOverview(false);
  if (ctrl && !e.altKey) {
    switch (key) {
      case 't':
        return e.shiftKey ? reopenClosedTab : () => openURL('', true);
      case 'h':
        return () => togglePanel('history');
      case 'j':
        return () => togglePanel('downloads');
      case 'd':
        return () => tab && toggleBookmark(tab.url, tab.title);
      case 'w':
        return () => tab && requestClose(tab);
      case 'l':
        return focusAddress;
      case 'f':
        return openFind;
      case 'g':
        return () => findAgain(e.shiftKey);
      case 'r':
        return () => tab?.view.reload();
      case 'u':
        return () => tab?.view.viewSource();
      case 'p':
        return () => printTab(tab);
      case '+':
      case '=':
        return () => tab && changeZoom(tab.view, 1);
      case '-':
        return () => tab && changeZoom(tab.view, -1);
      case '0':
        return () => tab && changeZoom(tab.view, 0);
      case 'Tab':
        return () => switchTab(e.shiftKey ? -1 : 1);
      case 'PageDown':
      case 'PageUp': {
        const offset = key === 'PageDown' ? 1 : -1;
        // With Shift the tab moves, like Chrome
        if (!e.shiftKey) return () => switchTab(offset);
        return () => tab && moveTab(tab, allTabs().indexOf(tab) + offset);
      }
    }
    if (/^[1-9]$/.test(key)) {
      return () => {
        const tabs = allTabs();
        const target = key === '9' ? tabs.at(-1) : tabs[Number(key) - 1];
        if (target) activate(target);
      };
    }
    return null;
  }
  if (e.altKey && !ctrl && tab) {
    if (key === 'ArrowLeft') return () => tab.view.back();
    if (key === 'ArrowRight') return () => tab.view.forward();
    if (key === 'd') return focusAddress;
  }
  if (!ctrl && !e.altKey) {
    switch (key) {
      case 'F5':
        return () => tab?.view.reload();
      case 'F6':
        return focusAddress;
      case 'F3':
        return () => findAgain(e.shiftKey);
    }
  }
  return null;
}

// An open select popup or context menu of the ui package takes its keys itself
const uiPopupOpen = () => !!document.querySelector('.bl-select-popup, .bl-context-menu');

const ready = () => runtime.browser?.state === 'ready' && !uiPopupOpen();

/**
 * Keyboard shortcuts of the browser, skipped while a popup of the ui package is open. In the
 * capture phase of the window, before the demo's fields, except the ones that run last; a key for
 * the page of the active tab goes to the page first unless the shortcut is reserved.
 */
export function installShortcuts(): void {
  let swallowKeyUp: string | null = null;
  window.addEventListener(
    'keydown',
    (e) => {
      // Autofill and some on-screen keyboards send key events without a key
      if (!ready() || e.isComposing || typeof e.key !== 'string') return;
      const found = shortcut(e);
      if (!found || found.last) return;
      // Not the host browser's own action (F5 would reload the demo)
      e.preventDefault();
      if (!found.reserved && activeTab()?.view.focused) return;
      swallowKeyUp = e.code;
      e.stopImmediatePropagation();
      found.run();
    },
    true,
  );
  window.addEventListener('keydown', (e) => {
    if (!ready() || e.defaultPrevented || e.isComposing || typeof e.key !== 'string') return;
    if (activeTab()?.view.focused) return;
    const found = shortcut(e);
    if (found?.last) found.run();
  });
  onTabCreated((tab) =>
    tab.view.on('unhandled-key', (key) => {
      if (ready() && tab.isActive) shortcut(key)?.run();
    }),
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (swallowKeyUp && e.code === swallowKeyUp) {
        swallowKeyUp = null;
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}
