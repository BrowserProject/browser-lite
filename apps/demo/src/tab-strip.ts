import { byId } from './util.js';

// Scrolling of the tab strip once its tabs have shrunk to their minimum width, like Chrome and
// Firefox: the active tab stays in view, the mouse wheel scrolls the strip.

let activeElement: HTMLElement | null = null;
let sizes: ResizeObserver | null = null;

/**
 * Scrolls the strip so the tab element of the active tab is in view, and keeps it there whenever
 * a tab or the strip changes size: a new tab grows in, a tab goes, the window resizes. A strip
 * the user scrolled stays as it is while nothing changes size.
 */
export function showActiveInStrip(element: HTMLElement): void {
  activeElement = element;
  reveal();
}

/** The strip watches the size of a new tab element. */
export function watchStripTab(element: HTMLElement): void {
  if (!sizes) {
    sizes = new ResizeObserver(reveal);
    sizes.observe(byId('tab-list'));
  }
  sizes.observe(element);
}

/** The strip stops watching the element of a tab that went. */
export function unwatchStripTab(element: HTMLElement): void {
  sizes?.unobserve(element);
}

/** The vertical mouse wheel over the strip scrolls it sideways, like Chrome and Firefox. */
export function initTabStripWheel(): void {
  const strip = byId('tab-list');
  strip.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      strip.scrollLeft +=
        e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : unit);
    },
    { passive: false },
  );
}

function reveal(): void {
  if (!activeElement?.isConnected) return;
  const strip = byId('tab-list');
  // The phone layout has no strip
  if (!strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  const tab = activeElement.getBoundingClientRect();
  // The padding of the strip holds the curves that join the active tab to the toolbar
  const inset = Number.parseFloat(getComputedStyle(strip).paddingLeft) || 0;
  const before = tab.left - (box.left + inset);
  const after = tab.right - (box.right - inset);
  if (before < 0) strip.scrollLeft += before;
  else if (after > 0) strip.scrollLeft += after;
}
