import { allTabs, moveTab, type Tab } from './tabs.js';
import { byId } from './util.js';

// CSS px along the strip before a press becomes a drag: a click only activates the tab
const THRESHOLD = 5;

/**
 * Reordering tabs by dragging them with the mouse or a pen, like Chrome and Firefox: the tab
 * follows the pointer along the strip and takes the place of a neighbour once it covers half of
 * it. A finger keeps scrolling the strip.
 */
export function initTabDrag(): void {
  const strip = byId('tab-list');
  strip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || !(e.target instanceof Element)) return;
    if (e.target.closest('button')) return;
    const node = e.target.closest('.tab');
    const tab = allTabs().find((tab) => tab.element === node);
    if (tab) follow(strip, tab, e);
  });
}

function follow(strip: HTMLElement, tab: Tab, down: PointerEvent): void {
  const node = tab.element;
  let shift = 0;
  let dragging = false;
  const listening = new AbortController();
  // Where an element sits in the strip, without the shift of the dragged tab
  const home = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const offset = element === node ? shift : 0;
    return { left: rect.left - offset, right: rect.right - offset, width: rect.width };
  };
  const middle = (element: HTMLElement) => {
    const { left, right } = home(element);
    return (left + right) / 2;
  };
  const grab = down.clientX - home(node).left;

  const place = (x: number) => {
    const tabs = allTabs();
    const first = tabs[0];
    const last = tabs.at(-1);
    if (!first || !last || !tabs.includes(tab)) return;
    const { width } = home(node);
    const left = Math.min(
      Math.max(x - grab, home(first.element).left),
      home(last.element).right - width,
    );
    for (let step = 0; step < tabs.length; step++) {
      const index = allTabs().indexOf(tab);
      const next = allTabs()[index + 1];
      const previous = allTabs()[index - 1];
      if (next && left + width > middle(next.element)) moveTab(tab, index + 1);
      else if (previous && left < middle(previous.element)) moveTab(tab, index - 1);
      else break;
    }
    shift = left - home(node).left;
    node.style.translate = `${shift}px 0`;
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    // Released where this page got no pointerup (outside the window)
    if (!(e.buttons & 1)) return end(e);
    if (!dragging) {
      if (Math.abs(e.clientX - down.clientX) < THRESHOLD) return;
      dragging = true;
      // The page under the pointer gets nothing while a tab moves
      strip.setPointerCapture(e.pointerId);
      node.classList.add('dragging');
    }
    place(e.clientX);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    listening.abort();
    if (!dragging) return;
    if (strip.hasPointerCapture(e.pointerId)) strip.releasePointerCapture(e.pointerId);
    // Slides into its place
    node.classList.remove('dragging');
    node.style.translate = '';
  };
  const options = { capture: true, signal: listening.signal };
  window.addEventListener('pointermove', move, options);
  window.addEventListener('pointerup', end, options);
  window.addEventListener('pointercancel', end, options);
}
