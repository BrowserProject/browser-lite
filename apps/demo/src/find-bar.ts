import type { View, ViewEvents } from '@browser-lite/core';
import { byId } from './util.js';

const bar = byId('find-bar');
const input = byId<HTMLInputElement>('find-input');
const count = byId('find-count');
let timer: ReturnType<typeof setTimeout> | undefined;
let api: { view(): View | null; focusPage(): void } = { view: () => null, focusPage: () => {} };
/** The view the bar shows, and the open find of background tabs, like Chrome per tab. */
let shown: View | null = null;
const sessions = new WeakMap<View, { text: string; count: string }>();

/** Result of a search ('find' event of the view). */
type FindResult = ViewEvents['find'];

/** Connects the find bar (Ctrl+F) with the active view. */
export function initFindBar(options: typeof api): void {
  api = options;
}

function run(backwards: boolean, again: boolean, view = api.view()): void {
  clearTimeout(timer);
  timer = undefined;
  view?.find(input.value, { backwards, again });
}

/** Count text of a result like Chrome, past the engine's limit like Safari ("1000+"). */
function countText({ text, matches, index, more }: FindResult): string {
  if (!text) return '';
  if (!matches) return 'No matches';
  const total = more ? `${matches}+` : `${matches}`;
  if (index) return `${index} of ${total}`;
  return more ? `${total} matches` : `1 of ${total}`;
}

/** Hides the bar; the page gets the focus back when the bar had it. */
function hide(): void {
  const focused = bar.contains(document.activeElement);
  bar.hidden = true;
  count.textContent = '';
  if (focused) api.focusPage();
}

/**
 * Opens the bar with the last text selected, like Firefox without searching it again: typing
 * replaces it, Enter searches it. A search on open would run before the one typed next and keep
 * the bar on its result for as long as it takes on a long page.
 */
export function openFind(): void {
  const view = api.view();
  if (!view) return;
  shown = view;
  bar.hidden = false;
  input.focus();
  input.select();
}

/** Next (or previous) match; opens the bar when closed. */
export function findAgain(backwards: boolean): void {
  if (bar.hidden) openFind();
  if (input.value) run(backwards, true);
}

export function closeFind(): void {
  if (bar.hidden) return;
  bar.hidden = true;
  count.textContent = '';
  api.view()?.stopFind();
  api.focusPage();
}

/**
 * Shows the find bar of view, the newly active tab: its own open find with text and result or a
 * closed bar. The find of the tab left stays open with its marks until it is shown again.
 */
export function showFindOf(view: View): void {
  if (view === shown) return;
  if (!bar.hidden && shown) {
    // A search still waiting for typing to pause belongs to the tab left
    if (timer) run(false, false, shown);
    sessions.set(shown, { text: input.value, count: count.textContent ?? '' });
  }
  shown = view;
  const session = sessions.get(view);
  sessions.delete(view);
  if (!session) {
    hide();
    return;
  }
  input.value = session.text;
  input.defaultValue = session.text;
  count.textContent = session.count;
  bar.hidden = false;
}

/** A new document in view (navigation or reload) ends its find, like Chrome closes the bar. */
export function endFind(view: View): void {
  sessions.delete(view);
  if (view === shown && !bar.hidden) {
    clearTimeout(timer);
    timer = undefined;
    hide();
  }
}

/**
 * Result of view ('find' event), also of a background tab whose find is open. A result for
 * another text than the bar's belongs to an earlier search and is dropped.
 */
export function showFindCount(view: View, result: FindResult): void {
  const session = sessions.get(view);
  if (session) {
    if (result.text === session.text) session.count = countText(result);
  } else if (view === shown && !bar.hidden && result.text === input.value)
    count.textContent = countText(result);
}

input.addEventListener('input', () => {
  // The text survives a return from the page cache like the address bar's (showAddress)
  input.defaultValue = input.value;
  count.textContent = '';
  clearTimeout(timer);
  timer = setTimeout(() => run(false, false), 150);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    run(e.shiftKey, true);
    e.preventDefault();
  }
});
// On the whole bar: a click on a button moves the focus there (Chromium, Firefox)
bar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFind();
    e.preventDefault();
  }
});
byId('find-next').addEventListener('click', () => run(false, true));
byId('find-prev').addEventListener('click', () => run(true, true));
byId('find-close').addEventListener('click', closeFind);
