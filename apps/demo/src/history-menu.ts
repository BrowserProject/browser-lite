import { type MenuItem, showMenu } from '@browser-lite/ui';
import { openPanel } from './side-panel.js';
import { activeTab, allTabs, focusPage, type Tab } from './tabs.js';
import { byId } from './util.js';

/** Entries of the list, nearest first, like Chrome's back and forward menu. */
const MAX_ENTRIES = 12;
/** How long a press on Back or Forward is held before the list opens. */
const HOLD_MS = 500;

/**
 * The list of the tab's earlier pages on Back and of its later pages on Forward, like Chrome: it
 * opens below the button on a right click, a held press (mouse or finger) and the context menu
 * key. A chosen entry is reached in one step (`view.go`), Show full history opens the history
 * panel. The release of a held press does not go back or forward as well.
 */
export function initHistoryMenu(): void {
  attach(byId<HTMLButtonElement>('back'), -1);
  attach(byId<HTMLButtonElement>('forward'), 1);
}

function attach(button: HTMLButtonElement, direction: -1 | 1): void {
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressed = false;
  // A held press opened the list: the click of its release does nothing
  let heldOpen = false;
  const open = () => {
    const tab = activeTab();
    if (!tab || button.disabled) return;
    const rect = button.getBoundingClientRect();
    showMenu(items(tab, direction, button), { x: rect.left, y: rect.bottom });
  };
  const release = () => {
    pressed = false;
    clearTimeout(holdTimer);
  };

  // Like a left press, a right press takes no focus
  button.addEventListener('mousedown', (e) => {
    if (e.button === 2) e.preventDefault();
  });
  button.addEventListener('pointerdown', (e) => {
    release();
    heldOpen = false;
    if (e.button !== 0) return;
    pressed = true;
    holdTimer = setTimeout(() => {
      heldOpen = true;
      open();
    }, HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const)
    button.addEventListener(type, release);
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clearTimeout(holdTimer);
    // The long press of a finger brings a contextmenu while it is still down
    if (!(pressed && heldOpen)) open();
  });
  // Capture: before the button's own click listener on the same element. A click from the
  // keyboard (detail 0) always acts.
  button.addEventListener(
    'click',
    (e) => {
      if (!heldOpen || e.detail === 0) return;
      heldOpen = false;
      e.stopImmediatePropagation();
    },
    true,
  );
}

/**
 * The entries before (direction -1) or after (1) the current one, nearest first, then Show full
 * history; nothing without such an entry.
 */
function items(tab: Tab, direction: -1 | 1, button: HTMLButtonElement): MenuItem[] {
  const history = tab.view.history;
  const result: MenuItem[] = [];
  for (let offset = direction; history && result.length < MAX_ENTRIES; offset += direction) {
    const entry = history.entries[history.index + offset];
    if (!entry) break;
    result.push({
      id: `go${offset}`,
      label: entry.title || entry.url,
      action: () => {
        if (!allTabs().includes(tab)) return;
        tab.view.go(offset);
        if (document.activeElement !== button) focusPage();
      },
    });
  }
  if (!result.length) return [];
  return [
    ...result,
    { separator: true },
    { id: 'show-history', label: 'Show full history', action: () => openPanel('history') },
  ];
}
