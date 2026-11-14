import type { FileChooserRequest, RequestHandlers } from '@browser-lite/core';
import { watchClose } from './close-watchers.js';
import { context, element, listen, type UiOptions } from './options.js';
import { needsTap, tapSheet } from './tap-sheet.js';

/**
 * File inputs of the pages for an iPhone or iPad, where Safari opens its file chooser only on a
 * tap: a sheet at the top of the window with a visible file input (multiple and accept of the
 * page's field) and Cancel (`form.bl-picker-sheet.bl-file-sheet`). Resolves the chosen files,
 * null on Cancel, a tap elsewhere, a close request (`closeNewest`) or abort. Elsewhere an empty
 * object: the core's default opens the chooser at once.
 */
export function fileChooser(options?: UiOptions): Partial<Pick<RequestHandlers, 'fileChooser'>> {
  const ui = context(options);
  const doc = options?.root?.ownerDocument ?? globalThis.document;
  if (!doc || !needsTap(doc)) return {};
  return {
    fileChooser: (request: FileChooserRequest) =>
      new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve(null);
          return;
        }
        const root = ui.root();
        const input = element(root, 'input', 'host-picker');
        input.type = 'file';
        input.multiple = request.multiple;
        if (request.accept) input.accept = request.accept;
        const finish = (files: File[] | null) => {
          stopListening();
          stopWatch();
          sheet.remove();
          resolve(files);
        };
        const sheet = tapSheet(ui, input, () => finish(null));
        sheet.classList.add('bl-file-sheet');
        const stopListening = listen([
          [input, 'change', () => finish([...(input.files ?? [])])],
          [input, 'cancel', () => finish(null)],
          [request.signal, 'abort', () => finish(null)],
          [
            root.ownerDocument,
            'pointerdown',
            (event) => {
              if (!sheet.contains(event.target as Node)) finish(null);
            },
            true,
          ],
        ]);
        const stopWatch = watchClose(() => finish(null));
        root.append(sheet);
      }),
  };
}
