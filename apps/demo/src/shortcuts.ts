import { focusAddress } from './address-bar.js';
import { toggleBookmark } from './bookmarks.js';
import { findAgain, findOpen, openFind } from './find-bar.js';
import { closePreview, previewOpen } from './print-preview.js';
import { runtime } from './runtime.js';
import { settingsOpen } from './settings-page.js';
import { panelOpen, togglePanel } from './side-panel.js';
import { overviewOpen, toggleOverview } from './tab-overview.js';
import {
  activate,
  activeTab,
  allTabs,
  openURL,
  printTab,
  requestClose,
  switchTab,
} from './tabs.js';
import { changeZoom } from './zoom.js';

// Like Chrome. Some (Ctrl+T/W/N/Tab) Chrome passes to pages only in an app window; here they
// are always the browser's.
function shortcut(e: KeyboardEvent): boolean {
  // The settings are modal (Esc closes them itself)
  if (settingsOpen()) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const tab = activeTab();
  if (key === 'Escape' && previewOpen()) {
    closePreview();
    return true;
  }
  if (ctrl && e.shiftKey && key === 'o') {
    togglePanel('bookmarks');
    return true;
  }
  if (key === 'Escape' && panelOpen()) {
    togglePanel(null);
    return true;
  }
  if (key === 'Escape' && overviewOpen()) {
    toggleOverview(false);
    return true;
  }
  if (ctrl && !e.altKey) {
    switch (key) {
      case 't':
        openURL('', true);
        return true;
      case 'h':
        togglePanel('history');
        return true;
      case 'j':
        togglePanel('downloads');
        return true;
      case 'd':
        if (tab) toggleBookmark(tab.url, tab.title);
        return true;
      case 'w':
        if (tab) requestClose(tab);
        return true;
      case 'l':
        focusAddress();
        return true;
      case 'f':
        openFind();
        return true;
      case 'g':
        if (findOpen()) findAgain(e.shiftKey);
        else openFind();
        return true;
      case 'r':
        tab?.view.reload();
        return true;
      case 'u':
        tab?.view.viewSource();
        return true;
      case 'p':
        printTab(tab);
        return true;
      case '+':
      case '=':
        if (tab) changeZoom(tab.view, 1);
        return true;
      case '-':
        if (tab) changeZoom(tab.view, -1);
        return true;
      case '0':
        if (tab) changeZoom(tab.view, 0);
        return true;
      case 'Tab':
        switchTab(e.shiftKey ? -1 : 1);
        return true;
      case 'PageDown':
        switchTab(1);
        return true;
      case 'PageUp':
        switchTab(-1);
        return true;
    }
    if (/^[1-9]$/.test(key)) {
      const tabs = allTabs();
      const target = key === '9' ? tabs.at(-1) : tabs[Number(key) - 1];
      if (target) activate(target);
      return true;
    }
    return false;
  }
  if (e.altKey && !ctrl && tab) {
    if (key === 'ArrowLeft') {
      tab.view.back();
      return true;
    }
    if (key === 'ArrowRight') {
      tab.view.forward();
      return true;
    }
    if (key === 'd') {
      focusAddress();
      return true;
    }
  }
  if (!ctrl && !e.altKey) {
    switch (key) {
      case 'F5':
        tab?.view.reload();
        return true;
      case 'F6':
        focusAddress();
        return true;
      case 'F3':
        findAgain(e.shiftKey);
        return true;
    }
  }
  return false;
}

// An open select popup or context menu of the ui package takes its keys itself
const uiPopupOpen = () => !!document.querySelector('.bl-select-popup, .bl-context-menu');

/**
 * Keyboard shortcuts of the browser. In the capture phase of the window, so they never reach the
 * page; skipped while a popup of the ui package is open.
 */
export function installShortcuts(): void {
  let swallowKeyUp: string | null = null;
  window.addEventListener(
    'keydown',
    (e) => {
      if (runtime.browser?.state !== 'ready' || e.isComposing || uiPopupOpen()) return;
      if (shortcut(e)) {
        swallowKeyUp = e.code;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
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
