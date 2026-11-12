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
  type Tab,
} from './tabs.js';
import { byId } from './util.js';

/**
 * The menu of a right click on the tab strip, like Chrome: on a tab New tab to the right, Reload,
 * Duplicate, Mute or Unmute tab, Close, Close other tabs, Close tabs to the right and Reopen
 * closed tab; on the free part of the strip New tab and Reopen closed tab.
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

function tabItems(tab: Tab): MenuItem[] {
  const tabs = allTabs();
  const others = tabs.filter((other) => other !== tab);
  const right = tabs.slice(tabs.indexOf(tab) + 1);
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
      id: 'mute',
      label: tab.view.muted ? 'Unmute tab' : 'Mute tab',
      action: forTab(tab, () => tab.toggleMuted()),
    },
    { separator: true },
    { id: 'close', label: 'Close', action: forTab(tab, () => requestClose(tab)) },
    {
      id: 'close-others',
      label: 'Close other tabs',
      enabled: others.length > 0,
      action: forTab(tab, () =>
        closeTabs(
          allTabs().filter((other) => other !== tab),
          tab,
        ),
      ),
    },
    {
      id: 'close-right',
      label: 'Close tabs to the right',
      enabled: right.length > 0,
      action: forTab(tab, () => closeTabs(allTabs().slice(allTabs().indexOf(tab) + 1), tab)),
    },
    { separator: true },
    reopen(),
  ];
}

function stripItems(): MenuItem[] {
  return [{ id: 'new-tab', label: 'New tab', action: () => void openNewTab() }, reopen()];
}
