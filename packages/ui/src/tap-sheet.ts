import { element, type UiContext } from './options.js';

/**
 * iPhone and iPad (also as "Macintosh" with touch): Safari opens its pickers and file choosers
 * only on a tap or within the tap (focus(), click()), not later: a request comes after a round
 * trip through the engine. showPicker() does nothing for dates there.
 */
export function needsTap(doc: Document): boolean {
  const nav = doc.defaultView?.navigator;
  return !!nav && /iPhone|iPad|iPod|Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

/**
 * A small sheet (`form.bl-picker-sheet`, inline `position: fixed`) with the visible input whose
 * tap opens the host's own picker or file chooser, and `button[data-bl-answer=cancel]`.
 */
export function tapSheet(
  ui: UiContext,
  input: HTMLInputElement,
  onCancel: () => void,
): HTMLFormElement {
  const root = ui.root();
  const sheet = element(root, 'form', 'picker-sheet');
  sheet.style.position = 'fixed';
  const cancel = element(root, 'button', 'cancel');
  cancel.type = 'button';
  cancel.dataset.blAnswer = 'cancel';
  cancel.textContent = ui.texts.cancel;
  cancel.addEventListener('click', onCancel);
  sheet.append(input, cancel);
  return sheet;
}
