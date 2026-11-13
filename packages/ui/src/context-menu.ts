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

/** A line of text that names what the menu is for, like the address of a pressed link. */
export interface MenuHeader {
  header: string;
}

/** An entry of the context menu. */
export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

/** True for a separator item. */
export function isSeparator(item: MenuItem): item is MenuSeparator {
  return 'separator' in item && item.separator;
}

/** True for a header item. */
export function isHeader(item: MenuItem): item is MenuHeader {
  return 'header' in item;
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

/** Where a menu opens and what it stays inside of. */
interface Placement {
  /** Point of the menu's top left corner in viewport coordinates. */
  x: number;
  y: number;
  /** Area the menu stays inside of, in viewport coordinates; the window when absent. */
  area?: DOMRectReadOnly;
  /** Runs after a command was chosen, before the command. */
  chosen?: () => void;
  /** Closes the menu when it runs the function it gets; returns a remover. */
  until?: (close: () => void) => () => void;
  /** Marks the menu with `data-bl-view` and `data-bl-touch`. */
  view?: View;
  touch?: boolean;
}

/**
 * Shows a context menu at the position of `info` (relative to the view canvas), kept inside the
 * visible part of the canvas (it scrolls when it is taller). A click on a command closes the
 * menu, runs it and gives the keyboard back to the page; only a press that began on the menu (or
 * the keyboard) chooses one. Escape, a click outside, losing the window focus or closing the view
 * close it. Only one menu is open at a time; without any command none opens. Returns a function
 * that closes the menu.
 * Element: `.bl-context-menu` (with `data-bl-touch` for a long press) with `div.bl-menu-header`,
 * `button.bl-menu-item` and `hr.bl-separator`.
 */
export function showContextMenu(
  view: View,
  info: ContextMenuInfo,
  items: MenuItem[],
  options?: UiOptions,
): () => void {
  const area = view.canvas.getBoundingClientRect();
  return openMenu(
    items,
    {
      x: area.left + info.x,
      y: area.top + info.y,
      area,
      chosen: () => view.focus(),
      until: (close) => view.on('close', close),
      view,
      touch: info.touch,
    },
    options,
  );
}

/**
 * Shows a menu of the embedding page itself, like the menu of a tab in a tab strip: the same
 * element and behaviour as `showContextMenu`, at `x`, `y` in viewport coordinates (the
 * `clientX`, `clientY` of a `contextmenu` event), kept inside the visible part of the window.
 * A press on the menu does not move the keyboard focus, so it stays where it was. Returns a
 * function that closes the menu.
 */
export function showMenu(
  items: MenuItem[],
  at: { x: number; y: number },
  options?: UiOptions,
): () => void {
  return openMenu(items, { x: at.x, y: at.y }, options);
}

function openMenu(items: MenuItem[], at: Placement, options?: UiOptions): () => void {
  closeOpen?.();
  const entries = normalizeMenu(items);
  if (!entries.some((item) => !isSeparator(item) && !isHeader(item))) return () => {};
  const root = context(options).root();
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const menu = element(root, 'div', 'context-menu');
  menu.setAttribute('role', 'menu');
  if (at.view) menu.dataset.blView = String(at.view.id);
  if (at.touch) menu.dataset.blTouch = '';

  const close = () => {
    if (closeOpen !== close) return;
    closeOpen = null;
    stopListening();
    stopUntil?.();
    menu.remove();
  };
  closeOpen = close;
  // The lift of a finger held down to open the menu (on a button, a row) clicks whatever lies
  // under it, maybe an item: only a press that began on the menu, or the keyboard, chooses one
  let pressed = false;

  for (const item of entries) {
    if (isSeparator(item)) {
      menu.append(element(root, 'hr', 'separator'));
      continue;
    }
    if (isHeader(item)) {
      const header = element(root, 'div', 'menu-header');
      header.setAttribute('role', 'presentation');
      header.textContent = item.header;
      header.title = item.header;
      menu.append(header);
      continue;
    }
    const button = element(root, 'button', 'menu-item');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = item.enabled === false;
    if (item.id) button.dataset.blItem = item.id;
    button.addEventListener('click', (event) => {
      if (!pressed && event.detail !== 0) return;
      close();
      void Promise.resolve()
        .then(() => item.action())
        .catch((error: unknown) => console.warn('context menu:', error));
      at.chosen?.();
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
    [
      menu,
      'pointerdown',
      () => {
        pressed = true;
      },
    ],
    // The keyboard stays where it was (the page, a field of the app)
    [menu, 'mousedown', (event) => event.preventDefault()],
  ]);
  const stopUntil = at.until?.(close);

  root.append(menu);
  place(menu, at, win);
  return close;
}

/** Room kept between the menu and the edge of the area it may cover. */
const MARGIN = 4;

/**
 * At the point of `at`, moved and if needed shortened (it scrolls then) to stay inside the
 * visible part of its area: what the app puts beside a view (a toolbar at the bottom on a phone)
 * or the on-screen keyboard may be in front of the menu.
 */
function place(menu: HTMLElement, at: Placement, win: Window): void {
  const visual = win.visualViewport;
  const area = at.area;
  const top = Math.max(area?.top ?? 0, 0, visual?.offsetTop ?? 0);
  const bottom = Math.min(
    area?.bottom ?? Number.POSITIVE_INFINITY,
    win.innerHeight,
    visual ? visual.offsetTop + visual.height : Number.POSITIVE_INFINITY,
  );
  const left = Math.max(area?.left ?? 0, 0);
  const right = Math.min(area?.right ?? Number.POSITIVE_INFINITY, win.innerWidth);
  const style = menu.style;
  style.position = 'fixed';
  style.maxHeight = `${Math.max(0, bottom - top - 2 * MARGIN)}px`;
  style.overflowY = 'auto';
  style.left = `${Math.max(left, Math.min(at.x, right - menu.offsetWidth - MARGIN))}px`;
  style.top = `${Math.max(top + MARGIN, Math.min(at.y, bottom - menu.offsetHeight - MARGIN))}px`;
}
