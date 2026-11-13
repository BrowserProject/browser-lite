import { profile } from './runtime.js';
import { isInternal } from './util.js';

/** A bookmark; the list is the pref `bookmarks` of the profile. */
export interface Bookmark {
  url: string;
  title: string;
  time: number;
}

const listeners = new Set<() => void>();

export function bookmarks(): Bookmark[] {
  return profile.prefs<Bookmark[]>('bookmarks') ?? [];
}

export function isBookmarked(url: string): boolean {
  return bookmarks().some((bookmark) => bookmark.url === url);
}

/** Adds or removes the bookmark of url; true when it was added. */
export function toggleBookmark(url: string, title = ''): boolean {
  if (isInternal(url)) return false;
  const list = bookmarks();
  const index = list.findIndex((bookmark) => bookmark.url === url);
  if (index >= 0) list.splice(index, 1);
  else list.push({ url, title: title || url, time: Date.now() });
  save(list);
  return index < 0;
}

/** Removes the bookmark of url; nothing when there is none. */
export function removeBookmark(url: string): void {
  const list = bookmarks();
  const kept = list.filter((bookmark) => bookmark.url !== url);
  if (kept.length !== list.length) save(kept);
}

function save(list: Bookmark[]): void {
  profile.savePrefs('bookmarks', list);
  for (const listener of listeners) listener();
}

/** Calls listener after every change of the bookmarks. */
export function onBookmarksChange(listener: () => void): void {
  listeners.add(listener);
}
