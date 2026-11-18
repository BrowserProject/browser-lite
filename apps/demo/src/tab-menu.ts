import { type MenuItem, showMenu } from '@browser-lite/ui';
import { hasClosed } from './closed-tabs.js';
import {
  allTabs,
  closeTabs,
  duplicateTab,
  openNewTab,
  reloadTab,
  reopenClosedTab,
  requestClose,
  setPinned,
  type Tab,
} from './tabs.js';
import { byId } from './util.js';

/**
 * The menu of a right click on the tab strip, like Chrome: on a tab New tab to the right, Reload,
 * Duplicate, Pin or Unpin, Mute or Unmute tab, Close, Close other tabs, Close tabs to the right
 * (both keep the pinned tabs) and Reopen closed tab; on the free part of the strip New tab and
 * Reopen closed tab.
 */
export function initTabMenu(): void {
  const strip = byId('tabs');
  // Like a left press on a tab, a right press takes no focus: the page or the address bar keeps
  // the keyboard
  strip.addEventListener('mousedown', (e) => {
    if (e.button === 2) e.preventDefault();
  });
  strip.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element)) return;
    e.preventDefault();
    const node = e.target.closest('.tab');
    const tab = node && allTabs().find((tab) => tab.element === node);
    showMenu(tab ? tabItems(tab) : stripItems(), { x: e.clientX, y: e.clientY });
  });
}

const reopen = (): MenuItem => ({
  id: 'reopen-closed',
  label: 'Reopen closed tab',
  enabled: hasClosed(),
  action: reopenClosedTab,
});

// A command for tab while it is still open (a page may close it while the menu shows)
const forTab =
  (tab: Tab, run: () => void): (() => void) =>
  () => {
    if (allTabs().includes(tab)) run();
  };

// Like Chrome, Close other tabs and Close tabs to the right leave the pinned tabs open
const others = (tab: Tab) => allTabs().filter((other) => other !== tab && !other.pinned);
const toTheRight = (tab: Tab) =>
  allTabs()
    .slice(allTabs().indexOf(tab) + 1)
    .filter((other) => !other.pinned);

function tabItems(tab: Tab): MenuItem[] {
  return [
    {
      id: 'new-tab-right',
      label: 'New tab to the right',
      action: forTab(tab, () => openNewTab(tab)),
    },
    { separator: true },
    { id: 'reload', label: 'Reload', action: forTab(tab, () => reloadTab(tab)) },
    { id: 'duplicate', label: 'Duplicate', action: forTab(tab, () => duplicateTab(tab)) },
    {
      id: 'pin',
      label: tab.pinned ? 'Unpin' : 'Pin',
      action: forTab(tab, () => setPinned(tab, !tab.pinned)),
    },
    {
      id: 'mute',
      label: tab.view.muted ? 'Unmute tab' : 'Mute tab',
      action: forTab(tab, () => tab.toggleMuted()),
    },
    { separator: true },
    { id: 'close', label: 'Close', action: forTab(tab, () => requestClose(tab)) },
    {
      id: 'close-others',
      label: 'Close other tabs',
      enabled: others(tab).length > 0,
      action: forTab(tab, () => closeTabs(others(tab), tab)),
    },
    {
      id: 'close-right',
      label: 'Close tabs to the right',
      enabled: toTheRight(tab).length > 0,
      action: forTab(tab, () => closeTabs(toTheRight(tab), tab)),
    },
    { separator: true },
    reopen(),
  ];
}

function stripItems(): MenuItem[] {
  return [{ id: 'new-tab', label: 'New tab', action: () => void openNewTab() }, reopen()];
}
