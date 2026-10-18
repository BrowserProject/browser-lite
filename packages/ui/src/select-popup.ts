import type { RequestHandlers, SelectRequest } from '@browser-lite/core';
import { context, element, listen, type UiOptions, viewportRect } from './options.js';
import { createTypeahead, moveHighlight } from './select-keys.js';

interface Entry {
  index: number;
  row: HTMLElement;
  text: string;
}

/**
 * List of a `<select>` below the field (above when there is more room), with keyboard
 * navigation (arrows, page keys, Home/End, typing jumps to a matching entry, Enter or Space
 * chooses, Escape or Tab cancels). A click outside, a resize or losing the window focus
 * cancels. Elements: `.bl-select-popup` with rows `.bl-option` (`data-bl-highlighted`,
 * `aria-selected`, `aria-disabled`), `.bl-group` and `hr.bl-separator`.
 */
export function selectPopup(options?: UiOptions): Pick<RequestHandlers, 'selectPopup'> {
  const ui = context(options);
  let current: ((index: number) => void) | null = null;

  return {
    selectPopup(request: SelectRequest): Promise<number> {
      current?.(-1);
      return new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve(-1);
          return;
        }
        const root = ui.root();
        const doc = root.ownerDocument;
        const win = doc.defaultView ?? window;
        const popup = element(root, 'div', 'select-popup');
        popup.setAttribute('role', 'listbox');
        popup.dataset.blView = String(request.view.id);
        const entries: Entry[] = [];
        let highlighted = -1;
        const typeahead = createTypeahead();

        const highlight = (position: number) => {
          const old = entries[highlighted];
          if (old) delete old.row.dataset.blHighlighted;
          old?.row.classList.remove('bl-highlighted');
          highlighted = position;
          const entry = entries[position];
          if (!entry) return;
          entry.row.dataset.blHighlighted = '';
          entry.row.classList.add('bl-highlighted');
          entry.row.scrollIntoView?.({ block: 'nearest' });
        };

        const finish = (index: number, refocus: boolean) => {
          if (current !== close) return;
          current = null;
          stopListening();
          request.signal.removeEventListener('abort', onAbort);
          typeahead.reset();
          popup.remove();
          resolve(index);
          if (refocus) request.view.focus();
        };
        const close = (index: number) => finish(index, false);
        const choose = (index: number) => finish(index, true);
        const onAbort = () => finish(-1, false);
        current = close;

        request.items.forEach((item, index) => {
          if (item.separator) {
            popup.append(element(root, 'hr', 'separator'));
            return;
          }
          const row = element(root, 'div', item.label ? 'group' : 'option');
          row.textContent = item.text || ' ';
          if (item.tooltip) row.title = item.tooltip;
          if (!item.label) {
            row.setAttribute('role', 'option');
            row.dataset.blIndex = String(index);
            if (item.selected) row.setAttribute('aria-selected', 'true');
            if (!item.enabled) {
              row.setAttribute('aria-disabled', 'true');
            } else {
              const position = entries.length;
              entries.push({ index, row, text: (item.text || '').trim().toLowerCase() });
              row.addEventListener('pointerenter', () => highlight(position));
              row.addEventListener('click', () => choose(index));
            }
          }
          popup.append(row);
        });

        const onKey = (event: Event) => {
          const e = event as KeyboardEvent;
          let handled = true;
          const move = moveHighlight(e.key, highlighted, entries.length);
          if (move !== null) {
            highlight(move);
          } else if (e.key === 'Enter' || e.key === ' ') {
            const entry = entries[highlighted];
            choose(entry ? entry.index : -1);
          } else if (e.key === 'Escape' || e.key === 'Tab') {
            choose(-1);
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const match = typeahead.type(
              e.key,
              entries.map((entry) => entry.text),
            );
            if (match >= 0) highlight(match);
          } else {
            handled = false;
          }
          if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        };
        const onPointer = (event: Event) => {
          if (!popup.contains(event.target as Node)) choose(-1);
        };
        // Keys go to the popup while it is open, wherever the focus is (the page keeps it)
        const stopListening = listen([
          [win, 'keydown', onKey, true],
          [doc, 'pointerdown', onPointer, true],
          [win, 'blur', () => choose(-1)],
          [win, 'resize', () => choose(-1)],
        ]);
        request.signal.addEventListener('abort', onAbort);

        root.append(popup);
        place(popup, viewportRect(request.view, request.rect), win);
        highlight(
          Math.max(
            0,
            entries.findIndex((entry) => entry.index === request.selectedIndex),
          ),
        );
      });
    },
  };
}

/** Below the field, else above; never beyond the window edge. */
function place(
  popup: HTMLElement,
  anchor: { x: number; y: number; width: number; height: number },
  win: Window,
) {
  const style = popup.style;
  style.position = 'fixed';
  style.minWidth = `${anchor.width}px`;
  style.maxHeight = '';
  style.overflowY = 'auto';
  const below = win.innerHeight - (anchor.y + anchor.height) - 8;
  const above = anchor.y - 8;
  const height = popup.offsetHeight;
  if (height <= below || below >= above) {
    style.top = `${anchor.y + anchor.height}px`;
    style.maxHeight = `${Math.max(below, 80)}px`;
  } else {
    style.maxHeight = `${above}px`;
    style.top = `${anchor.y - Math.min(height, above)}px`;
  }
  style.left = `${Math.max(4, Math.min(anchor.x, win.innerWidth - popup.offsetWidth - 4))}px`;
}
