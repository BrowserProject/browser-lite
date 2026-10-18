import type { View } from '@browser-lite/core';
import { byId } from './util.js';

const bar = byId('find-bar');
const input = byId<HTMLInputElement>('find-input');
const count = byId('find-count');
let timer: ReturnType<typeof setTimeout> | undefined;
let api: { view(): View | null; focusPage(): void } = { view: () => null, focusPage: () => {} };

/** Connects the find bar (Ctrl+F) with the active view. */
export function initFindBar(options: typeof api): void {
  api = options;
}

export const findOpen = (): boolean => !bar.hidden;

function run(backwards: boolean, again: boolean): void {
  api.view()?.find(input.value, { backwards, again });
}

export function openFind(): void {
  if (!api.view()) return;
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

/** Result of the active view ('find' event). */
export function showFindCount(matches: number, index: number): void {
  count.textContent = input.value ? (matches ? `${index || 1} of ${matches}` : 'No matches') : '';
}

input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => run(false, false), 150);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    run(e.shiftKey, true);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeFind();
    e.preventDefault();
  }
});
byId('find-next').addEventListener('click', () => run(false, true));
byId('find-prev').addEventListener('click', () => run(true, true));
byId('find-close').addEventListener('click', closeFind);
