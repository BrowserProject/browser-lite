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

/** Bookmarks url with title (the address without one); nothing when it is bookmarked. */
export function addBookmark(url: string, title = ''): void {
  const list = bookmarks();
  if (isInternal(url) || list.some((bookmark) => bookmark.url === url)) return;
  list.push({ url, title: title || url, time: Date.now() });
  save(list);
}

/** Names the bookmark of url title (the address without one); nothing when there is none. */
export function renameBookmark(url: string, title: string): void {
  const list = bookmarks();
  const bookmark = list.find((entry) => entry.url === url);
  if (!bookmark || bookmark.title === (title || url)) return;
  bookmark.title = title || url;
  save(list);
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
