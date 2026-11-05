import type { DataListRequest, RequestHandlers } from '@browser-lite/core';
import { context, element, listen, type UiOptions, viewportRect } from './options.js';
import { placeAtField } from './popup-place.js';

/**
 * Suggestions of an `<input list>` below the field (above when there is more room), like the
 * dropdown of Chrome. The field keeps the focus and the keys (the engine moves the highlight
 * and sends a new request), so the list takes no keys and a press on it does not move the focus.
 * A click on an entry chooses it; a click outside the list and the view, a change of the window
 * width or losing the window focus closes it. Elements: `.bl-datalist-popup` with rows
 * `.bl-option` (`data-bl-highlighted`, `span.bl-value` and `span.bl-label`).
 */
export function dataListPopup(options?: UiOptions): Pick<RequestHandlers, 'dataListPopup'> {
  const ui = context(options);
  let current: ((index: number) => void) | null = null;

  return {
    dataListPopup(request: DataListRequest): Promise<number> {
      current?.(-1);
      return new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve(-1);
          return;
        }
        const root = ui.root();
        const doc = root.ownerDocument;
        const win = doc.defaultView ?? window;
        const popup = element(root, 'div', 'datalist-popup');
        popup.setAttribute('role', 'listbox');
        popup.dataset.blView = String(request.view.id);

        const finish = (index: number) => {
          if (current !== finish) return;
          current = null;
          stopListening();
          request.signal.removeEventListener('abort', onAbort);
          popup.remove();
          resolve(index);
        };
        const onAbort = () => finish(-1);
        current = finish;

        let highlighted: HTMLElement | null = null;
        for (const [index, suggestion] of request.suggestions.entries()) {
          const row = element(root, 'div', 'option');
          row.setAttribute('role', 'option');
          row.dataset.blIndex = String(index);
          const value = element(root, 'span', 'value');
          value.textContent = suggestion.value;
          row.append(value);
          if (suggestion.label) {
            const label = element(root, 'span', 'label');
            label.textContent = suggestion.label;
            row.append(label);
          }
          if (index === request.highlightedIndex) {
            row.dataset.blHighlighted = '';
            row.classList.add('bl-highlighted');
            row.setAttribute('aria-selected', 'true');
            highlighted = row;
          }
          row.addEventListener('click', () => finish(index));
          popup.append(row);
        }

        // The focus stays in the view: the user types on after a click on an entry
        const keepFocus = (event: Event) => event.preventDefault();
        const onPointer = (event: Event) => {
          const target = event.target as Node;
          // A press in the page is the engine's: it closes the list when the field loses focus
          if (!popup.contains(target) && !request.view.canvas.contains(target)) finish(-1);
        };
        const width = win.innerWidth;
        const stopListening = listen([
          [popup, 'pointerdown', keepFocus],
          [popup, 'mousedown', keepFocus],
          [doc, 'pointerdown', onPointer, true],
          [win, 'blur', () => finish(-1)],
          [win, 'resize', () => win.innerWidth !== width && finish(-1)],
        ]);
        request.signal.addEventListener('abort', onAbort);

        root.append(popup);
        placeAtField(popup, viewportRect(request.view, request.rect), win);
        highlighted?.scrollIntoView?.({ block: 'nearest' });
      });
    },
  };
}
