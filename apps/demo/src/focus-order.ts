import { focusAddress } from './address-bar.js';
import { activeTab, focusPage, onTabCreated } from './tabs.js';
import { byId } from './util.js';

// Like Chrome's focus traversal: Tab goes through the controls of the top bar in their order and
// from the last one into the page, Shift+Tab before the page's first element comes back to that
// last control, Tab past the page's last element goes to the address bar. F6 switches between
// the toolbar and the page like Chrome's panes.

const chrome = () => byId('chrome');

/** The controls of the top bar that Tab stops at, in their order. */
function chromeControls(): HTMLElement[] {
  return [
    ...chrome().querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    ),
  ].filter(
    (control) =>
      control.tabIndex >= 0 &&
      !(control as HTMLButtonElement).disabled &&
      control.checkVisibility({ visibilityProperty: true }),
  );
}

/** First control of the new tab page, which the demo draws over the blank view of its tab. */
const newTabPageControl = () =>
  byId('new-tab-page').querySelector<HTMLElement>('button, input, a[href]');

/**
 * F6 and Shift+F6: from the toolbar to the page of the active tab, from anywhere else to the
 * address bar, like Chrome's panes.
 */
export function focusNextPane(): void {
  const tab = activeTab();
  const inChrome = chrome().contains(document.activeElement);
  if (!tab || !inChrome || tab.view.focused) focusAddress();
  else if (tab.newTab) newTabPageControl()?.focus();
  else focusPage();
}

/** Tab between the top bar and the page of the active tab. */
export function installFocusOrder(): void {
  chrome().addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.defaultPrevented || e.isComposing || e.target !== chromeControls().at(-1)) return;
    const tab = activeTab();
    // The new tab page follows the top bar in the document
    if (!tab || tab.newTab) return;
    e.preventDefault();
    tab.view.focusFirstElement(true);
  });
  onTabCreated((tab) =>
    tab.view.on('take-focus', ({ forward }) => {
      if (!tab.isActive) return;
      const last = chromeControls().at(-1);
      if (forward || !last) focusAddress();
      else last.focus();
    }),
  );
}
