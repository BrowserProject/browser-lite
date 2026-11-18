import type { ContextMenuInfo, View } from '@browser-lite/core';
import { watchClose } from './close-watchers.js';
import { context, element, listen, type UiOptions } from './options.js';

/** A command of the context menu. */
export interface MenuAction {
  label: string;
  action(): void | Promise<void>;
  /** Default true. */
  enabled?: boolean;
  /**
   * Makes it a checkable item like Chrome's Loop and Show controls (`role=menuitemcheckbox`,
   * `aria-checked`); undefined for a plain command.
   */
  checked?: boolean;
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
  /**
   * Rows the menu keeps clear of (a selection with handles, viewport coordinates): above them,
   * else below them, else at the point.
   */
  clear?: { top: number; bottom: number };
}

/**
 * Shows a context menu at the position of `info` (relative to the view canvas), kept inside the
 * visible part of the canvas (it scrolls when it is taller). A click on a command closes the
 * menu, runs it and gives the keyboard back to the page; only a press that began on the menu (or
 * the keyboard) chooses one. The keyboard works the menu like in Chrome while it is open, and no
 * key reaches the page or the app then: the arrow keys, Home and End move a highlight over the
 * enabled commands (wrapping around, the pointer moves it too), Enter or Space runs the
 * highlighted one, a letter highlights the next command starting with it and runs it when it is
 * the only one. Escape, a click outside, losing the window focus, closing the view or a close
 * request (`closeNewest`) close it. Only one menu is open at a time; without any command none
 * opens. Returns a function that closes the menu.
 * Element: `.bl-context-menu` (with `data-bl-touch` for a long press) with `div.bl-menu-header`,
 * `button.bl-menu-item` (`.bl-highlighted` and `data-bl-highlighted` on the highlighted one,
 * `role=menuitemcheckbox` and `aria-checked` on a checkable one) and `hr.bl-separator`.
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
      clear: info.selectionBounds && {
        top: area.top + info.selectionBounds.y,
        bottom: area.top + info.selectionBounds.y + info.selectionBounds.height,
      },
    },
    options,
  );
}

/**
 * Shows a menu of the embedding page itself, like the menu of a tab in a tab strip: the same
 * element and behaviour as `showContextMenu`, at `x`, `y` in viewport coordinates (the
 * `clientX`, `clientY` of a `contextmenu` event), kept inside the visible part of the window.
 * A press on the menu does not move the keyboard focus, so it stays where it was; the keys go to
 * the menu while it is open. Returns a function that closes the menu.
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
    stopWatch();
    menu.remove();
  };
  closeOpen = close;
  const stopWatch = watchClose(close);
  // The lift of a finger held down to open the menu (on a button, a row) clicks whatever lies
  // under it, maybe an item: only a press that began on the menu, or the keyboard, chooses one
  let pressed = false;
  const commands: { button: HTMLButtonElement; item: MenuAction }[] = [];
  let highlighted = -1;
  const highlight = (position: number) => {
    const old = commands[highlighted]?.button;
    old?.classList.remove('bl-highlighted');
    if (old) delete old.dataset.blHighlighted;
    highlighted = position;
    const button = commands[position]?.button;
    if (!button) return;
    button.classList.add('bl-highlighted');
    button.dataset.blHighlighted = '';
    button.scrollIntoView?.({ block: 'nearest' });
  };
  const choose = (item: MenuAction) => {
    close();
    void Promise.resolve()
      .then(() => item.action())
      .catch((error: unknown) => console.warn('context menu:', error));
    at.chosen?.();
  };

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
    if (item.checked === undefined) button.setAttribute('role', 'menuitem');
    else {
      button.setAttribute('role', 'menuitemcheckbox');
      button.setAttribute('aria-checked', String(item.checked));
    }
    button.textContent = item.label;
    button.disabled = item.enabled === false;
    if (item.id) button.dataset.blItem = item.id;
    button.addEventListener('click', (event) => {
      if (pressed || event.detail === 0) choose(item);
    });
    if (!button.disabled) {
      const position = commands.length;
      commands.push({ button, item });
      button.addEventListener('pointerenter', () => highlight(position));
      button.addEventListener('pointerleave', () => highlighted === position && highlight(-1));
    }
    menu.append(button);
  }

  // Keys go to the menu wherever the focus is (the page or a field of the app keeps it)
  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    event.preventDefault();
    event.stopImmediatePropagation();
    const key = typeof e.key === 'string' ? e.key : '';
    const move = moveInMenu(key, highlighted, commands.length);
    if (key === 'Escape') {
      close();
    } else if (move !== null) {
      highlight(move);
    } else if (key === 'Enter' || key === ' ') {
      const command = commands[highlighted];
      if (command) choose(command.item);
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      const found = findByLetter(
        key,
        commands.map((command) => command.item.label),
        highlighted,
      );
      if (found) highlight(found.position);
      const command = commands[highlighted];
      if (found?.only && command) choose(command.item);
    }
  };

  const stopListening = listen([
    [
      doc,
      'pointerdown',
      (event) => {
        if (!menu.contains(event.target as Node)) close();
      },
      true,
    ],
    [win, 'keydown', onKey, true],
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

/**
 * Position a navigation key moves the highlight of a menu with `count` commands to, from
 * `position` (-1 for none), wrapping around like Chrome's menus; null when the key does not move.
 */
export function moveInMenu(key: string, position: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return position < 0 || position >= count - 1 ? 0 : position + 1;
    case 'ArrowUp':
      return position <= 0 ? count - 1 : position - 1;
    case 'Home':
    case 'PageUp':
      return 0;
    case 'End':
    case 'PageDown':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The next command after `position` whose label starts with the typed `key` (wrapping around),
 * and whether it is the only one, which Chrome then runs right away; null without a match.
 */
export function findByLetter(
  key: string,
  labels: readonly string[],
  position: number,
): { position: number; only: boolean } | null {
  const letter = key.toLowerCase();
  const matches = labels.flatMap((label, index) =>
    label.trim().toLowerCase().startsWith(letter) ? [index] : [],
  );
  const first = matches[0];
  if (first === undefined) return null;
  return {
    position: matches.find((index) => index > position) ?? first,
    only: matches.length === 1,
  };
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
  const height = menu.offsetHeight;
  let y = at.y;
  if (at.clear && at.clear.top - height - MARGIN >= top + MARGIN)
    y = at.clear.top - height - MARGIN;
  else if (at.clear && at.clear.bottom + height + MARGIN <= bottom - MARGIN)
    y = at.clear.bottom + MARGIN;
  style.top = `${Math.max(top + MARGIN, Math.min(y, bottom - height - MARGIN))}px`;
}
