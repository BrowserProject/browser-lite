import {
  addBookmark,
  bookmarks,
  isBookmarked,
  removeBookmark,
  renameBookmark,
} from './bookmarks.js';
import { closeOnHostBack, placeBubble } from './bubble.js';
import { compactLayout } from './layout.js';
import { byId, isInternal } from './util.js';

/** The page the bubble bookmarks. */
export interface BookmarkPage {
  url: string;
  title: string;
}

const bubble = () => byId<HTMLFormElement>('bookmark-bubble');
const nameField = () => byId<HTMLInputElement>('bookmark-name');
/** Address of the bookmark the open bubble edits, null while it is closed. */
let editing: string | null = null;
let removed = false;
/** Whether the name was edited since the bubble opened. */
let typed = false;

/**
 * Chrome's bookmark bubble. The star of the address bar (`popovertarget`), the Bookmark button of
 * the phone menu (a click on the star) and Ctrl+D bookmark the page in front when it is not yet
 * and open the bubble, "Bookmark added" or "Edit bookmark": its name, applied when the bubble
 * closes in any way but Remove, Remove and Done. Neither the star nor the shortcut removes a
 * bookmark by itself. `current` is the page in front, `focusPage` gives it the keyboard.
 */
export function initBookmarkBubble(
  current: () => BookmarkPage | null,
  focusPage: () => void,
): void {
  const popover = bubble();
  closeOnHostBack(popover);
  // The whole name is selected, so typing replaces it. Safari puts the caret at the start after
  // the focus event, so the toggle event selects it once more unless a key came first
  const field = nameField();
  field.addEventListener('focus', () => field.select());
  field.addEventListener('input', () => {
    typed = true;
  });
  popover.addEventListener('beforetoggle', (event) => {
    if ((event as ToggleEvent).newState !== 'open') {
      if (editing && !removed) renameBookmark(editing, nameField().value.trim());
      editing = null;
      return;
    }
    const page = current();
    if (!page || isInternal(page.url)) event.preventDefault();
    else fill(page);
  });
  popover.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState === 'open') {
      if (document.activeElement === field && !typed) field.select();
    } else if (document.activeElement === document.body) focusPage();
  });
  popover.addEventListener('submit', (e) => {
    e.preventDefault();
    popover.hidePopover();
  });
  // Escape closes the bubble only, it does not also stop a page that is loading
  popover.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    popover.hidePopover();
  });
  popover.querySelector('.bookmark-remove')?.addEventListener('click', () => {
    removed = true;
    if (editing) removeBookmark(editing);
    popover.hidePopover();
  });
  // Like the other buttons of the toolbar, a press does not take the keyboard from the page
  byId('bookmark').addEventListener('mousedown', (e) => {
    if (e.button === 0) e.preventDefault();
  });
}

/** Ctrl+D: opens the bubble for the page in front; nothing while it is open. */
export function openBookmarkBubble(): void {
  const popover = bubble();
  if (!popover.matches(':popover-open')) popover.showPopover();
}

/** Closes the bubble when the page in front is no longer at the address it edits. */
export function followBookmarkBubble(url: string): void {
  if (editing !== null && editing !== url) bubble().hidePopover();
}

function fill(page: BookmarkPage): void {
  const added = !isBookmarked(page.url);
  editing = page.url;
  removed = false;
  typed = false;
  addBookmark(page.url, page.title);
  byId('bookmark-bubble-title').textContent = added ? 'Bookmark added' : 'Edit bookmark';
  const field = nameField();
  field.value = bookmarks().find((bookmark) => bookmark.url === page.url)?.title ?? page.title;
  // The popover focuses the name as it opens, so no key typed right after is lost; not on a
  // phone, where the focus would bring up the keyboard over the page
  field.autofocus = !compactLayout();
  // The star, or the menu button of the phone layout, which has no star
  const star = byId('bookmark');
  placeBubble(bubble(), star.getClientRects().length ? star : byId('menu-button'));
}
