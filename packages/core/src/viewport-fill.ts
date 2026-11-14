/**
 * The styles of a filled element: those of the user agent for `:fullscreen` and its black
 * `::backdrop`, with the safe areas of a notched screen kept free, so controls in the corners
 * of the page stay reachable.
 */
const FILL_STYLE: Record<string, string> = {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  'min-width': '0',
  'min-height': '0',
  'max-width': 'none',
  'max-height': 'none',
  margin: '0',
  border: '0',
  padding:
    'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
  'box-sizing': 'border-box',
  overflow: 'hidden',
  transform: 'none',
  background: '#000',
  color: 'inherit',
  'z-index': '2147483647',
};

/**
 * Makes `element` fill the viewport of its window above everything else, for hosts without
 * element fullscreen (iPhone Safari, a frame without `allow="fullscreen"`): the element goes
 * into the top layer as a manual popover, so no ancestor clips it and nothing of the page lies
 * above it, and takes the styles of `:fullscreen`. Esc of the host calls `onEscape`, like it
 * ends host fullscreen. Returns the function that puts everything back.
 */
export function fillViewport(element: HTMLElement, onEscape: () => void): () => void {
  const style = element.style;
  const saved = Object.keys(FILL_STYLE).map(
    (name) => [name, style.getPropertyValue(name), style.getPropertyPriority(name)] as const,
  );
  for (const [name, value] of Object.entries(FILL_STYLE))
    style.setProperty(name, value, 'important');
  const topLayer = typeof element.showPopover === 'function' && !element.hasAttribute('popover');
  if (topLayer) {
    element.setAttribute('popover', 'manual');
    element.showPopover();
  }
  const win = element.ownerDocument.defaultView ?? window;
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onEscape();
  };
  win.addEventListener('keydown', keydown, true);
  return () => {
    win.removeEventListener('keydown', keydown, true);
    if (topLayer) {
      if (element.matches(':popover-open')) element.hidePopover();
      element.removeAttribute('popover');
    }
    for (const [name, value, priority] of saved) {
      if (value) style.setProperty(name, value, priority);
      else style.removeProperty(name);
    }
  };
}
