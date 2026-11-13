import { clearClosed } from './closed-tabs.js';
import { clearIcons } from './favicons.js';
import { isInternal, readJSON } from './util.js';

/** A visited page; only on this device (localStorage), never in the profile. */
export interface Visit {
  url: string;
  title: string;
  time: number;
}

const KEY = 'bl-history';
const MAX_ENTRIES = 3000;
const listeners = new Set<() => void>();
const removeListeners = new Set<() => void>();

/** The start of the local day of time; the history panel shows a page once per day. */
export const startOfDay = (time: number): number => new Date(time).setHours(0, 0, 0, 0);

export function readHistory(): Visit[] {
  return readJSON<Visit[]>(KEY, []);
}

function write(history: Visit[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // Full: drop the older half and try again
    if (history.length > 10) {
      try {
        localStorage.setItem(KEY, JSON.stringify(history.slice(-Math.floor(history.length / 2))));
      } catch {}
    }
  }
  for (const listener of listeners) listener();
}

/** Records a visit; the title often comes after the address and completes the last entry. */
export function recordVisit(url: string, title: string): void {
  if (isInternal(url)) return;
  const history = readHistory();
  const last = history.at(-1);
  if (last && last.url === url && Date.now() - last.time < 30 * 60 * 1000) {
    if (title) last.title = title;
  } else {
    history.push({ url, title: title || '', time: Date.now() });
  }
  write(history.slice(-MAX_ENTRIES));
}

/** Clears the history, the closed tabs and the remembered icons of the sites. */
export function clearHistory(): void {
  clearClosed();
  clearIcons();
  write([]);
  for (const listener of removeListeners) listener();
}

/**
 * Removes the visits of url on the day of time, like Remove from history on Chrome's history
 * page: the entry the panel shows for that day. Visits on other days stay.
 */
export function removeFromHistory(url: string, time: number): void {
  const day = startOfDay(time);
  const history = readHistory();
  const kept = history.filter((visit) => visit.url !== url || startOfDay(visit.time) !== day);
  if (kept.length === history.length) return;
  write(kept);
  for (const listener of removeListeners) listener();
}

/** Calls listener after every change of the history. */
export function onHistoryChange(listener: () => void): void {
  listeners.add(listener);
}

/** Calls listener after visits were removed: those of one page or the whole history. */
export function onHistoryRemove(listener: () => void): void {
  removeListeners.add(listener);
}
