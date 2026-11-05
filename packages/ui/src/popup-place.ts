import type { Rect } from '@browser-lite/core';

/**
 * Places a list at a field: below it, else above when there is more room; at least as wide as
 * the field and never beyond the window edge. `anchor` is in viewport coordinates.
 */
export function placeAtField(popup: HTMLElement, anchor: Rect, win: Window) {
  const style = popup.style;
  style.position = 'fixed';
  style.minWidth = `${anchor.width}px`;
  style.maxHeight = '';
  style.overflowY = 'auto';
  const below = win.innerHeight - (anchor.y + anchor.height) - 8;
  const above = anchor.y - 8;
  const height = popup.offsetHeight;
  if (height <= below || below >= above) {
    style.top = `${anchor.y + anchor.height}px`;
    style.maxHeight = `${Math.max(below, 80)}px`;
  } else {
    style.maxHeight = `${above}px`;
    style.top = `${anchor.y - Math.min(height, above)}px`;
  }
  style.left = `${Math.max(4, Math.min(anchor.x, win.innerWidth - popup.offsetWidth - 4))}px`;
}
