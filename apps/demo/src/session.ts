import type { SessionHistory } from '@browser-lite/core';
import { startSettings } from './settings.js';
import { isInternal, readJSON } from './util.js';

/** A tab of the saved session (only on this device). */
export interface SessionEntry {
  url: string;
  title: string;
  active: boolean;
  pinned?: boolean;
  history?: SessionHistory;
}

/** What the session needs to know of a tab. */
export interface SessionTab {
  /** Address of the page, or of the one a restored tab still loads. */
  readonly sessionURL: string;
  readonly title: string;
  readonly pinned: boolean;
  /** Back/forward list, or the one waiting for the first activation. */
  readonly sessionHistory: SessionHistory | null;
}

const KEY = 'bl-session';

// Per tab also back/forward: at most 25 entries around the current one
function trim(tab: SessionTab): SessionHistory | undefined {
  const history = tab.sessionHistory;
  if (!history?.entries?.length) return undefined;
  const start = Math.max(0, history.index - 20);
  const entries = history.entries
    .slice(start, start + 25)
    .map(({ url, title, scrollX, scrollY }) => ({ url, title, scrollX, scrollY }));
  const index = Math.min(history.index - start, entries.length - 1);
  // The title often comes after the navigation
  const current = entries[index];
  if (current && current.url === tab.sessionURL && tab.title) current.title = tab.title;
  return { entries, index };
}

/** What brings a tab back: its address, title, back/forward list and whether it is pinned. */
export function sessionEntry(tab: SessionTab): Omit<SessionEntry, 'active'> {
  return {
    url: tab.sessionURL,
    title: tab.title,
    history: trim(tab),
    ...(tab.pinned ? { pinned: true } : {}),
  };
}

export function saveSession(tabs: readonly SessionTab[], active: SessionTab | null): void {
  const list: SessionEntry[] = tabs
    .filter((tab) => !isInternal(tab.sessionURL))
    .map((tab) => ({ ...sessionEntry(tab), active: tab === active }));
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: list, time: Date.now() }));
  } catch {}
}

/**
 * The tabs of the last session that come back at the start: all of them when `whole` is asked
 * for and the settings restore the session (`whole` true), else like Chrome only the pinned ones.
 */
export function sessionToRestore(whole: boolean): { tabs: SessionEntry[]; whole: boolean } {
  const tabs = readJSON<{ tabs?: SessionEntry[] } | null>(KEY, null)?.tabs ?? [];
  if (whole && startSettings().restoreSession) return { tabs, whole: true };
  return { tabs: tabs.filter((tab) => tab.pinned), whole: false };
}
