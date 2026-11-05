import type { SessionEntry } from './session.js';

/** A tab the user closed: what brings it back, and its place in the tab strip. */
export interface ClosedTab {
  entry: Omit<SessionEntry, 'active'>;
  index: number;
}

// Like Chrome: the last 25, only in this page (the history of the device keeps the addresses)
const MAX_CLOSED = 25;
const closed: ClosedTab[] = [];

/** Remembers a closed tab for Ctrl+Shift+T. */
export function rememberClosed(tab: ClosedTab): void {
  closed.push(tab);
  if (closed.length > MAX_CLOSED) closed.shift();
}

/** The tab closed last, removed from the list; undefined when none is left. */
export function takeClosed(): ClosedTab | undefined {
  return closed.pop();
}

/** Forgets all closed tabs (with the history). */
export function clearClosed(): void {
  closed.length = 0;
}
