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

export function clearHistory(): void {
  write([]);
}

/** Calls listener after every change of the history. */
export function onHistoryChange(listener: () => void): void {
  listeners.add(listener);
}
