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
 * Shows a context menu at the position of `info` (relative to the view canvas), kept inside
 * the window. A click on a command closes the menu, runs it and gives the keyboard back to the
 * page. Escape, a click outside, losing the window focus or closing the view close it. Only one
 * menu is open at a time. Returns a function that closes the menu.
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
      doc,
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
  const canvas = view.canvas.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(0, Math.min(canvas.left + info.x, win.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(canvas.top + info.y, win.innerHeight - menu.offsetHeight - 4))}px`;
  return close;
}
