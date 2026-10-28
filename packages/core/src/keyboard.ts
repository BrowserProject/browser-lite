import { modifierBits } from './input.js';
import type { ViewImpl } from './view.js';

interface KeyLike {
  key: string;
  code: string;
  keyCode: number;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?: (key: string) => boolean;
}

function keyText(e: KeyLike): string {
  if (e.ctrlKey || e.metaKey) return '';
  if (e.key.length === 1) return e.key;
  if (e.key === 'Enter') return '\r';
  if (e.key === 'Tab') return '\t';
  return '';
}

/** Sends a key event (type 0 down, 1 up) to the view. */
export function sendKey(view: ViewImpl, type: 0 | 1, e: KeyLike): void {
  const { host } = view;
  host.module._bl_key(
    view.id,
    type,
    host.text(e.key),
    host.text(e.code),
    host.text(keyText(e)),
    e.keyCode || 0,
    e.repeat ? 1 : 0,
    modifierBits(e),
  );
  if (type === 0) host.watchdog.inputSent();
}

const isPasteShortcut = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';

/**
 * Keyboard of a view: an invisible text field has the focus, not the canvas. Plain keys go
 * straight to the engine as keydown/keyup. Composed text (dead keys, IME for Chinese or
 * Japanese, on-screen keyboards) comes through the input and composition events and is
 * inserted as finished text; the composition preview is shown underlined in the page.
 */
export function createImeField(view: ViewImpl, signal: AbortSignal): HTMLTextAreaElement {
  const ime = document.createElement('textarea');
  ime.setAttribute('data-bl-ime', '');
  ime.setAttribute('aria-hidden', 'true');
  ime.autocomplete = 'off';
  // Safari and on-screen keyboards would change the text before the page gets it
  ime.setAttribute('autocorrect', 'off');
  ime.setAttribute('autocapitalize', 'off');
  ime.spellcheck = false;
  // On-screen keyboards only while the page has an editable element focused ("text-input")
  ime.inputMode = 'none';
  ime.tabIndex = -1;
  // 16px: iOS zooms the page into fields with a smaller font
  ime.style.cssText =
    'position:fixed;left:-1000px;top:0;width:1px;height:10px;opacity:0;pointer-events:none;resize:none;border:0;padding:0;margin:0;overflow:hidden;font-size:16px';
  const { host } = view;
  let composing = false;
  const isTextInput = (e: KeyboardEvent) =>
    e.isComposing ||
    composing ||
    e.key === 'Dead' ||
    e.key === 'Process' ||
    e.key === 'Unidentified' ||
    e.keyCode === 229;
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ) => ime.addEventListener(type, (event) => view.alive && listener(event), { signal });

  on('keydown', (e) => {
    // Paste: wait for the paste event, it carries the content
    if (isPasteShortcut(e) || isTextInput(e)) return;
    view.userInput(false);
    sendKey(view, 0, e);
    // Browser shortcuts like Tab, Backspace and Space stay in the page
    if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
  });
  on('keyup', (e) => {
    if (isPasteShortcut(e) || isTextInput(e)) return;
    sendKey(view, 1, e);
    e.preventDefault();
  });
  on('compositionstart', () => {
    composing = true;
  });
  on('compositionupdate', (e) => {
    const text = e.data || '';
    host.module._bl_set_composition(view.id, host.text(text), text.length, text.length);
  });
  on('compositionend', (e) => {
    composing = false;
    view.userInput(false);
    host.module._bl_confirm_composition(view.id, host.text(e.data || ''));
    ime.value = '';
  });
  on('input', (e) => {
    const event = e as InputEvent;
    if (composing || event.isComposing) return;
    if (
      event.data &&
      (event.inputType === 'insertText' || event.inputType === 'insertReplacementText')
    ) {
      view.userInput(false);
      host.module._bl_insert_text(view.id, host.text(event.data));
    }
    ime.value = '';
  });
  // Paste: text, HTML and files (for example a screenshot) like Chrome. Files go into the
  // engine file system like uploads; the page gets them in clipboardData.files.
  on('paste', async (e) => {
    e.preventDefault();
    view.userInput(false);
    const clipboardData = e.clipboardData;
    const data: Record<string, unknown> = { text: clipboardData?.getData('text/plain') ?? '' };
    const html = clipboardData?.getData('text/html');
    if (html) data.html = html;
    // After an await the data of the event is gone
    const files = [...(clipboardData?.files ?? [])];
    data.files = await host.uploads.write(view, files);
    if (!view.alive) return;
    host.module._bl_set_clipboard(host.text(JSON.stringify(data)));
    const shortcut: KeyLike = {
      key: 'v',
      code: 'KeyV',
      keyCode: 86,
      repeat: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    sendKey(view, 0, shortcut);
    sendKey(view, 1, shortcut);
  });
  return ime;
}
