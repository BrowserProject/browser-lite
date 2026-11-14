/**
 * The open overlays (menus, popups, sheets) that a close request of the embedding page closes,
 * newest first. A close request is what the platform's CloseWatcher answers on a phone: the
 * Android back key or gesture, Safari's back. The host page sees them as its own history moving
 * back, so it asks here first and goes back in the page only when nothing was open. Escape stays
 * with each overlay, which takes it while it has the keyboard.
 */

const open: (() => void)[] = [];
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * Registers an open overlay that `close` closes. Returns the function that removes it again, to
 * call when the overlay closes by itself (removing twice does nothing).
 */
export function watchClose(close: () => void): () => void {
  // Its own identity, so the same function registered twice is two entries
  const entry = () => close();
  open.push(entry);
  changed();
  return () => {
    const index = open.indexOf(entry);
    if (index < 0) return;
    open.splice(index, 1);
    changed();
  };
}

/** Closes the overlay opened last; false when none is open. */
export function closeNewest(): boolean {
  const newest = open.pop();
  if (!newest) return false;
  newest();
  changed();
  return true;
}

/** Whether an overlay is open that a close request would close. */
export function closeWatched(): boolean {
  return open.length > 0;
}

/**
 * Calls `listener` after an overlay opened or closed (for example to keep a history entry that
 * the next close request lands on). Returns the function that removes it.
 */
export function onCloseWatchedChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
