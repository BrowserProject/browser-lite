import type { ContextMenuInfo, View } from '@browser-lite/core';
import { context, element, listen, type UiOptions } from './options.js';

/** A command of the context menu. */
export interface MenuAction {
  label: string;
  action(): void | Promise<void>;
  /** Default true. */
  enabled?: boolean;
  /** Stable name for styling and tests (`data-bl-item`). */
  id?: string;
}

/** A line between groups of commands. */
export interface MenuSeparator {
  separator: true;
}

/** An entry of the context menu. */
export type MenuItem = MenuAction | MenuSeparator;

/** True for a separator item. */
export function isSeparator(item: MenuItem): item is MenuSeparator {
  return 'separator' in item && item.separator;
}

/** Items without separators at the start, at the end or next to each other. */
export function normalizeMenu(items: readonly MenuItem[]): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    if (isSeparator(item)) {
      const last = result.at(-1);
      if (!last || isSeparator(last)) continue;
    }
    result.push(item);
  }
  const last = result.at(-1);
  if (last && isSeparator(last)) result.pop();
  return result;
}

let closeOpen: (() => void) | null = null;

/**
 * Shows a context menu at the position of `info` (relative to the view canvas), kept inside the
 * visible part of the canvas (it scrolls when it is taller). A click on a command closes the
 * menu, runs it and gives the keyboard back to the page. Escape, a click outside, losing the
 * window focus or closing the view close it. Only one menu is open at a time. Returns a function
 * that closes the menu.
 * Element: `.bl-context-menu` with `button.bl-menu-item` and `hr.bl-separator`.
 */
export function showContextMenu(
  view: View,
  info: ContextMenuInfo,
  items: MenuItem[],
  options?: UiOptions,
): () => void {
  closeOpen?.();
  const root = context(options).root();
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const menu = element(root, 'div', 'context-menu');
  menu.setAttribute('role', 'menu');
  menu.dataset.blView = String(view.id);

  const close = () => {
    if (closeOpen !== close) return;
    closeOpen = null;
    stopListening();
    stopViewClose();
    menu.remove();
  };
  closeOpen = close;

  for (const item of normalizeMenu(items)) {
    if (isSeparator(item)) {
      menu.append(element(root, 'hr', 'separator'));
      continue;
    }
    const button = element(root, 'button', 'menu-item');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = item.enabled === false;
    if (item.id) button.dataset.blItem = item.id;
    button.addEventListener('click', () => {
      close();
      void Promise.resolve()
        .then(() => item.action())
        .catch((error: unknown) => console.warn('context menu:', error));
      view.focus();
    });
    menu.append(button);
  }

  const stopListening = listen([
    [
      doc,
      'pointerdown',
      (event) => {
        if (!menu.contains(event.target as Node)) close();
      },
      true,
    ],
    [
      win,
      'keydown',
      (event) => {
        if ((event as KeyboardEvent).key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      },
      true,
    ],
    [win, 'blur', close],
  ]);
  const stopViewClose = view.on('close', close);

  root.append(menu);
  place(menu, view.canvas.getBoundingClientRect(), info, win);
  return close;
}

/** Room kept between the menu and the edge of the area it may cover. */
const MARGIN = 4;

/**
 * At the position of `info`, moved and if needed shortened (it scrolls then) to stay inside the
 * visible part of the view canvas: what the app puts beside the view (a toolbar at the bottom on
 * a phone) or the on-screen keyboard may be in front of the menu.
 */
function place(
  menu: HTMLElement,
  canvas: DOMRectReadOnly,
  info: ContextMenuInfo,
  win: Window,
): void {
  const visual = win.visualViewport;
  const top = Math.max(canvas.top, 0, visual?.offsetTop ?? 0);
  const bottom = Math.min(
    canvas.bottom,
    win.innerHeight,
    visual ? visual.offsetTop + visual.height : Number.POSITIVE_INFINITY,
  );
  const left = Math.max(canvas.left, 0);
  const right = Math.min(canvas.right, win.innerWidth);
  const style = menu.style;
  style.position = 'fixed';
  style.maxHeight = `${Math.max(0, bottom - top - 2 * MARGIN)}px`;
  style.overflowY = 'auto';
  const x = canvas.left + info.x;
  const y = canvas.top + info.y;
  style.left = `${Math.max(left, Math.min(x, right - menu.offsetWidth - MARGIN))}px`;
  style.top = `${Math.max(top + MARGIN, Math.min(y, bottom - menu.offsetHeight - MARGIN))}px`;
}
