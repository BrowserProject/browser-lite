import { watchClose } from '@browser-lite/ui';

/**
 * Makes popover (an auto popover of index.html with the class `bubble`: light dismiss and Escape
 * by the browser) also close on a close request of the host page, the Android back key or
 * Safari's back, while it is open.
 */
export function closeOnHostBack(popover: HTMLElement): void {
  let stop: (() => void) | null = null;
  popover.addEventListener('toggle', (event) => {
    stop?.();
    stop =
      (event as ToggleEvent).newState === 'open' ? watchClose(() => popover.hidePopover()) : null;
  });
}

/**
 * Places popover at anchor like Chrome's bubbles of the address bar: below it while the anchor is
 * in the upper half of the window, above it in the lower half (the bar of the phone layout), its
 * right edge at the anchor's.
 */
export function placeBubble(popover: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect();
  const below = rect.top < innerHeight / 2;
  popover.style.top = below ? `${rect.bottom + 6}px` : 'auto';
  popover.style.bottom = below ? 'auto' : `${innerHeight - rect.top + 6}px`;
  const right = Math.max(8, innerWidth - rect.right);
  popover.style.right = `${right}px`;
  popover.style.maxWidth = `${innerWidth - right - 8}px`;
}
