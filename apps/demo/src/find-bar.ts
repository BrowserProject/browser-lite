import type { View } from '@browser-lite/core';
import { byId } from './util.js';

const bar = byId('find-bar');
const input = byId<HTMLInputElement>('find-input');
const count = byId('find-count');
let timer: ReturnType<typeof setTimeout> | undefined;
let api: { view(): View | null; focusPage(): void } = { view: () => null, focusPage: () => {} };
/** The view the bar shows, and the open find of background tabs, like Chrome per tab. */
let shown: View | null = null;
const sessions = new WeakMap<View, { text: string; count: string }>();

/** Connects the find bar (Ctrl+F) with the active view. */
export function initFindBar(options: typeof api): void {
  api = options;
}

export const findOpen = (): boolean => !bar.hidden;

function run(backwards: boolean, again: boolean, view = api.view()): void {
  clearTimeout(timer);
  timer = undefined;
  view?.find(input.value, { backwards, again });
}

function countText(text: string, matches: number, index: number): string {
  return text ? (matches ? `${index || 1} of ${matches}` : 'No matches') : '';
}

/** Hides the bar; the page gets the focus back when the bar had it. */
function hide(): void {
  const focused = bar.contains(document.activeElement);
  bar.hidden = true;
  count.textContent = '';
  if (focused) api.focusPage();
}

export function openFind(): void {
  const view = api.view();
  if (!view) return;
  shown = view;
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) run(false, false);
}

/** Next (or previous) match; opens the bar when closed. */
export function findAgain(backwards: boolean): void {
  if (bar.hidden) openFind();
  else run(backwards, true);
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

/** Result of view ('find' event), also of a background tab whose find is open. */
export function showFindCount(view: View, matches: number, index: number): void {
  const session = sessions.get(view);
  if (session) session.count = countText(session.text, matches, index);
  else if (view === shown && !bar.hidden)
    count.textContent = countText(input.value, matches, index);
}

input.addEventListener('input', () => {
  // The text survives a return from the page cache like the address bar's (showAddress)
  input.defaultValue = input.value;
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
