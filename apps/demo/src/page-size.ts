/**
 * Like Chrome, an on-screen keyboard for a field of the browser itself (address bar, panels,
 * dialogs) covers the page instead of making it smaller: the page area `pages` keeps the height
 * it had when such a field took the focus and the rest is cut off at the bottom, so the page is
 * not laid out again when the keyboard opens and once more when it closes. Fields in the
 * page area (the pages' own, the find bar) still make it smaller, so the engine keeps the field
 * visible above the keyboard. A rotation (another window width) gives the size free at once.
 */
export function keepPageSizeWhileEditing(pages: HTMLElement): void {
  let heldWidth = 0;
  const browserField = (target: EventTarget | null) =>
    target instanceof Element &&
    target.matches('input, textarea, [contenteditable]:not([contenteditable="false"])') &&
    !pages.contains(target);
  const hold = () => {
    if (heldWidth) return;
    heldWidth = window.innerWidth;
    pages.style.minHeight = `${pages.getBoundingClientRect().height}px`;
  };
  const release = () => {
    heldWidth = 0;
    pages.style.minHeight = '';
  };
  document.addEventListener('focusin', (e) => (browserField(e.target) ? hold() : release()));
  document.addEventListener('focusout', (e) => {
    if (!browserField(e.relatedTarget)) release();
  });
  addEventListener('resize', () => {
    if (heldWidth && window.innerWidth !== heldWidth) release();
  });
}
