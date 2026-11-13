/**
 * Links and text dropped on the browser UI (tab strip, address bar), from a page of a view
 * (`@browser-lite/core` sends its drags there) or from another window.
 */

/** Whether a drag carries a link or text (during dragover only the types are known). */
export function carriesText(transfer: DataTransfer | null): boolean {
  const types = transfer?.types ?? [];
  return types.includes('text/uri-list') || types.includes('text/plain');
}

/**
 * Accepts a drag over a drop target of the UI when it carries a link or text: preventDefault and
 * the copy cursor, like Chrome's tab strip and omnibox.
 */
export function acceptText(e: DragEvent): boolean {
  if (!carriesText(e.dataTransfer)) return false;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  return true;
}

/**
 * The dropped link (first entry of text/uri-list), else the text with its white space collapsed;
 * empty for a `javascript:` one, which Chrome strips too (a page could not run script through a
 * drop on the address bar).
 */
export function droppedText(transfer: DataTransfer | null): string {
  const link = (transfer?.getData('text/uri-list') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  const text = link ?? (transfer?.getData('text/plain') ?? '').replace(/\s+/g, ' ').trim();
  return /^javascript:/i.test(text) ? '' : text;
}
