import type { SessionHistory } from '@browser-lite/core';
import { startSettings } from './settings.js';
import { isInternal, readJSON } from './util.js';

/** A tab of the saved session (only on this device). */
export interface SessionEntry {
  url: string;
  title: string;
  active: boolean;
  history?: SessionHistory;
}

/** What the session needs to know of a tab. */
export interface SessionTab {
  readonly url: string;
  readonly title: string;
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
    .map((entry) => ({ url: entry.url, title: entry.title }));
  const index = Math.min(history.index - start, entries.length - 1);
  // The title often comes after the navigation
  const current = entries[index];
  if (current && current.url === tab.url && tab.title) current.title = tab.title;
  return { entries, index };
}

export function saveSession(tabs: readonly SessionTab[], active: SessionTab | null): void {
  const list: SessionEntry[] = tabs
    .filter((tab) => !isInternal(tab.url))
    .map((tab) => ({ url: tab.url, title: tab.title, active: tab === active, history: trim(tab) }));
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: list, time: Date.now() }));
  } catch {}
}

/** The tabs of the last session when they should come back, else null. */
export function sessionToRestore(): SessionEntry[] | null {
  if (!startSettings().restoreSession) return null;
  const session = readJSON<{ tabs?: SessionEntry[] } | null>(KEY, null);
  return session?.tabs?.length ? session.tabs : null;
}
