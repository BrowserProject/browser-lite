import type { ViewImpl } from './view.js';

/** A popup that stays on about:blank this long without a `new-view` listener closes. */
const BLANK_POPUP_MS = 10000;

/**
 * Popup without a `new-view` listener: nobody can show it, so its first address loads in the
 * opener instead and the popup closes before it runs anything (no hidden pages piling up).
 */
export function redirectPopup(popup: ViewImpl, opener: ViewImpl | null): void {
  const timer = setTimeout(() => void popup.close({ force: true }), BLANK_POPUP_MS);
  const off = popup.on('navigation', ({ url }) => {
    if (!url || url === 'about:blank') return;
    off();
    clearTimeout(timer);
    void popup.close({ force: true });
    if (opener && !opener.closed) opener.load(url);
  });
  popup.on('close', () => clearTimeout(timer));
}
