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
  profile.savePrefs('bookmarks', list);
  for (const listener of listeners) listener();
  return index < 0;
}

/** Calls listener after every change of the bookmarks. */
export function onBookmarksChange(listener: () => void): void {
  listeners.add(listener);
}
