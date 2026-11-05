import { hostOf } from './favicons.js';
import { runtime } from './runtime.js';
import type { Tab } from './tabs.js';
import { byId, element } from './util.js';

/** A popup the engine did not open (event `popup-blocked`). */
export interface BlockedPopup {
  url: string;
  origin: string;
}

/** Entries a tab keeps per document. */
const MAX_ENTRIES = 10;

const button = () => byId<HTMLButtonElement>('popups');
const bubble = () => byId('popup-bubble');
let shown: Tab | null = null;
let openTab: (url: string) => void = () => {};

/**
 * Pop-up blocker indicator like Chrome: an icon in the address bar while the page in front had
 * popups blocked. Its bubble lists them (a click opens one in a new tab) and allows popups for
 * the site from then on (permission 'popups' of the core, kept in the profile). `open` opens an
 * address in a new tab.
 */
export function initBlockedPopups(open: (url: string) => void): void {
  openTab = open;
  const popover = bubble();
  button().addEventListener('click', () => popover.togglePopover());
  popover.addEventListener('beforetoggle', (event) => {
    const opening = (event as ToggleEvent).newState === 'open';
    button().setAttribute('aria-expanded', String(opening));
    if (opening) fill();
  });
}

/** Remembers a popup the document in tab could not open. */
export function addBlockedPopup(tab: Tab, popup: BlockedPopup): void {
  if (tab.blockedPopups.length < MAX_ENTRIES) tab.blockedPopups.push(popup);
  if (tab.isActive) updatePopupsButton(tab);
}

/** Icon of the address bar for tab, the one in front. */
export function updatePopupsButton(tab: Tab): void {
  const changed = tab !== shown;
  shown = tab;
  const count = tab.blockedPopups.length;
  const node = button();
  node.hidden = count === 0;
  node.title = count === 1 ? 'Pop-up blocked' : `${count} pop-ups blocked`;
  node.setAttribute('aria-label', node.title);
  const popover = bubble();
  if (!popover.matches(':popover-open')) return;
  if (changed || !count) popover.hidePopover();
  else fill();
}

/** Content of the bubble for the tab in front, below the icon (above it in the phone bar). */
function fill(): void {
  const tab = shown;
  if (!tab) return;
  const popover = bubble();
  const close = () => {
    popover.hidePopover();
    updatePopupsButton(tab);
  };
  const list = element('ul', { className: 'popup-list' });
  for (const popup of tab.blockedPopups) {
    const entry = element('button', {
      type: 'button',
      className: 'popup-entry',
      textContent: popup.url || 'about:blank',
      title: popup.url,
    });
    entry.addEventListener('click', () => {
      tab.blockedPopups.splice(tab.blockedPopups.indexOf(popup), 1);
      close();
      openTab(popup.url);
    });
    list.append(element('li', {}, entry));
  }
  const done = element('button', { type: 'button', className: 'popup-done', textContent: 'Done' });
  done.addEventListener('click', () => popover.hidePopover());
  const actions = element('div', { className: 'popup-actions' }, done);
  // Pages without a host of their own (data:, sandboxed) cannot be allowed
  const origin = tab.blockedPopups[0]?.origin ?? '';
  const host = hostOf(origin);
  if (host) {
    const allow = element('button', {
      type: 'button',
      className: 'primary popup-allow',
      textContent: 'Always allow',
      title: `Always allow pop-ups from ${host}`,
    });
    allow.addEventListener('click', () => {
      runtime.browser?.setPermission(origin, 'popups', 'grant');
      tab.blockedPopups.length = 0;
      close();
    });
    actions.append(allow);
  }
  popover.replaceChildren(
    element('p', {
      className: 'popup-title',
      textContent: `Pop-ups blocked on ${host || 'this page'}`,
    }),
    list,
    actions,
  );
  const anchor = button().getBoundingClientRect();
  const below = anchor.top < innerHeight / 2;
  popover.style.top = below ? `${anchor.bottom + 6}px` : 'auto';
  popover.style.bottom = below ? 'auto' : `${innerHeight - anchor.top + 6}px`;
  const right = Math.max(8, innerWidth - anchor.right);
  popover.style.right = `${right}px`;
  popover.style.maxWidth = `${innerWidth - right - 8}px`;
}
