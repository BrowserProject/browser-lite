import { pendingClipboardWrite } from './clipboard.js';
import { modifierBits } from './input.js';
import type { UnhandledKey } from './types.js';
import { appleMobileHost } from './util.js';
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

/**
 * @internal True in Chromium (detected by its VirtualKeyboard API, which the core does not call):
 * there a focus by script after the user's tap opens the on-screen keyboard (ViewImpl.showKeyboard).
 */
export function focusOpensKeyboard(): boolean {
  return 'virtualKeyboard' in navigator;
}

/**
 * @internal Setter for the enter key hint of the IME field (the `enterkeyhint` of the page's
 * focused field). iOS gives its on-screen keyboard the hint only when an element gains focus, but
 * the IME field has the focus since the user's tap and gets the page field's hint after it
 * ("text-input"): the keyboard showed return instead of search in Google's search box. A blur and
 * focus of the same field in one task is no new focus there, so on iPhone and iPad the focus moves
 * through a second field and back when the hint differs from the one of the last focus. WebKit
 * then starts a new input session with the hint and keeps the keyboard open, as the focus only
 * moves from one field to another.
 */
export function enterKeyHintSetter(
  ime: HTMLTextAreaElement,
  signal: AbortSignal,
): (hint: string) => void {
  if (!appleMobileHost())
    return (hint) => {
      ime.enterKeyHint = hint;
    };
  let focusedHint = ime.enterKeyHint;
  ime.addEventListener(
    'focus',
    () => {
      focusedHint = ime.enterKeyHint;
    },
    { signal },
  );
  return (hint) => {
    ime.enterKeyHint = hint;
    if (hint === focusedHint || ime.inputMode === 'none' || document.activeElement !== ime) return;
    const relay = document.createElement('textarea');
    relay.setAttribute('aria-hidden', 'true');
    relay.inputMode = 'none';
    relay.tabIndex = -1;
    relay.style.cssText = ime.style.cssText;
    ime.after(relay);
    relay.focus({ preventScroll: true });
    ime.focus({ preventScroll: true });
    relay.remove();
  };
}

/**
 * @internal Previous and next field arrows of iOS (the bar above its on-screen keyboard) for the
 * fields of the page. iOS steps from the focused element to the host page's previous or next field
 * in tab order and cannot see the page's fields: the arrows took the focus to the host's address
 * bar. While the IME field has the focus, a field lies right before and one right after it; the
 * arrow that focuses one of them gives the focus back to the IME field and moves the page's focus
 * like Shift+Tab or Tab (`pressFieldArrow`). iOS skips fields that something covers at their
 * centre, so they lie side by side on the top left pixels of the view, over the canvas: `place`
 * puts them there again after the layout changed, `remove` takes them out of the document (the
 * IME field leaves it without a blur).
 */
export function attachFieldArrows(
  view: ViewImpl,
  ime: HTMLTextAreaElement,
  signal: AbortSignal,
): { place: () => void; remove: () => void } {
  if (!appleMobileHost()) return { place: () => {}, remove: () => {} };
  const arrow = (forward: boolean) => {
    const field = document.createElement('input');
    field.setAttribute('data-bl-field-arrow', forward ? 'next' : 'previous');
    field.setAttribute('aria-hidden', 'true');
    field.autocomplete = 'off';
    field.inputMode = 'none';
    field.style.cssText =
      'position:fixed;width:2px;height:2px;opacity:0;border:0;padding:0;margin:0;z-index:2147483647;font-size:16px';
    field.addEventListener(
      'focus',
      () => {
        ime.focus({ preventScroll: true });
        if (view.alive) pressFieldArrow(view, forward);
      },
      { signal },
    );
    return field;
  };
  const previous = arrow(false);
  const next = arrow(true);
  const remove = () => {
    previous.remove();
    next.remove();
  };
  const place = () => {
    const rect = view.canvas.getBoundingClientRect();
    previous.style.left = `${rect.left}px`;
    next.style.left = `${rect.left + 2}px`;
    for (const field of [previous, next]) field.style.top = `${rect.top}px`;
  };
  ime.addEventListener(
    'focus',
    () => {
      place();
      ime.before(previous);
      ime.after(next);
    },
    { signal },
  );
  ime.addEventListener(
    'blur',
    (e) => {
      if (e.relatedTarget !== previous && e.relatedTarget !== next) remove();
    },
    { signal },
  );
  signal.addEventListener('abort', remove);
  return { place, remove };
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
  if (type === 0) view.tabFromFieldArrow = false;
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

/** @internal The key of the engine event `unhandled-key` ({key, code, modifiers}). */
export function unhandledKey(data: Record<string, unknown>): UnhandledKey {
  const bits = Number(data.modifiers) || 0;
  return {
    key: String(data.key ?? ''),
    code: String(data.code ?? ''),
    shiftKey: !!(bits & 1),
    ctrlKey: !!(bits & 2),
    altKey: !!(bits & 4),
    metaKey: !!(bits & 8),
  };
}

const isPasteShortcut = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';

const key = (
  name: string,
  code: string,
  keyCode: number,
  { ctrlKey = false, shiftKey = false } = {},
): KeyLike => ({
  key: name,
  code,
  keyCode,
  repeat: false,
  ctrlKey,
  shiftKey,
  altKey: false,
  metaKey: false,
});
const BACKSPACE = key('Backspace', 'Backspace', 8);
const PASTE = key('v', 'KeyV', 86, { ctrlKey: true });
const TAB = key('Tab', 'Tab', 9);
const SHIFT_TAB = key('Tab', 'Tab', 9, { shiftKey: true });

function pressKey(view: ViewImpl, e: KeyLike): void {
  sendKey(view, 0, e);
  sendKey(view, 1, e);
}

/**
 * @internal Previous (false) or next (true) field arrow of the on-screen keyboard: Shift+Tab or
 * Tab in the page. Past the page's first or last element the page keeps no focus and the keyboard
 * closes; the arrows never take the focus to the host ('take-focus' is not emitted for them).
 */
export function pressFieldArrow(view: ViewImpl, forward: boolean): void {
  view.userInput(false);
  pressKey(view, forward ? TAB : SHIFT_TAB);
  view.tabFromFieldArrow = true;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * @internal How the page's text before the caret goes from `from` to `to`: the number of
 * Backspaces and the text inserted after them. A Backspace in the engine deletes one grapheme
 * cluster, so the change starts at the last cluster boundary before the first difference.
 */
export function textEdit(from: string, to: string): { backspaces: number; insert: string } {
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same++;
  let start = 0;
  let backspaces = 0;
  for (const { index, segment } of graphemes.segment(from)) {
    if (index + segment.length <= same) start = index + segment.length;
    else backspaces++;
  }
  return { backspaces, insert: to.slice(start) };
}

/**
 * Keyboard of a view: an invisible text field has the focus, not the canvas. Plain keys go
 * straight to the engine as keydown/keyup. Composed text (dead keys, IME for Chinese or
 * Japanese, on-screen keyboards) comes through the input and composition events and is
 * inserted as finished text; the composition preview is shown underlined in the page.
 *
 * The field keeps the text the input method entered since the page's caret last moved
 * otherwise, like the text before the caret of a real field: an on-screen keyboard deletes and
 * replaces within it (Gboard's Backspace after typing, a suggestion that replaces the word), and
 * every change of the field reaches the page as Backspaces and inserted text. In an emptied
 * field Gboard's Backspace changed nothing, so it never reached the page.
 */
export function createImeField(
  view: ViewImpl,
  signal: AbortSignal,
): { field: HTMLTextAreaElement; forget: () => void } {
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
  // Text of the field that the page has before its caret
  let entered = '';
  // Entered text when the composition began: the engine shows the composition after it
  let compositionBase: string | null = null;
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
  // The page's caret moved without the field (a key, a tap, another field): start empty, which
  // also tells the input method that there is no text before the caret
  const forget = () => {
    if (composing) return;
    entered = '';
    if (ime.value) ime.value = '';
  };
  const sync = () => {
    const { backspaces, insert } = textEdit(entered, ime.value);
    entered = ime.value;
    if (!backspaces && !insert) return;
    view.userInput(false);
    for (let i = 0; i < backspaces; i++) pressKey(view, BACKSPACE);
    if (insert) host.module._bl_insert_text(view.id, host.text(insert));
  };

  // Autofill and some on-screen keyboards send key events without a key: no key to forward
  on('keydown', (e) => {
    if (typeof e.key !== 'string') return;
    // Paste: wait for the paste event, it carries the content
    if (isPasteShortcut(e) || isTextInput(e)) return;
    view.userInput(false);
    forget();
    sendKey(view, 0, e);
    // Browser shortcuts like Tab, Backspace and Space stay in the page
    if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
  });
  on('keyup', (e) => {
    if (typeof e.key !== 'string' || isPasteShortcut(e) || isTextInput(e)) return;
    sendKey(view, 1, e);
    e.preventDefault();
  });
  on('compositionstart', () => {
    composing = true;
  });
  // A composition can also begin on text before the caret without compositionstart (Android
  // keyboards compose the word again on Backspace): the end corrects the text
  on('compositionupdate', (e) => {
    compositionBase ??= entered;
    const text = e.data || '';
    host.module._bl_set_composition(view.id, host.text(text), text.length, text.length);
  });
  on('compositionend', (e) => {
    composing = false;
    view.userInput(false);
    const text = e.data || '';
    host.module._bl_confirm_composition(view.id, host.text(text));
    entered = (compositionBase ?? entered) + text;
    compositionBase = null;
    sync();
  });
  on('input', (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    sync();
  });
  // Paste: text, HTML and files (for example a screenshot) like Chrome. Files go into the
  // engine file system like uploads; the page gets them in clipboardData.files.
  on('paste', async (e) => {
    e.preventDefault();
    view.userInput(false);
    forget();
    const clipboardData = e.clipboardData;
    // Right after a copy of a page the host clipboard may still have the old content
    const pending = pendingClipboardWrite();
    const data: Record<string, unknown> = {
      text: pending ? pending.text : (clipboardData?.getData('text/plain') ?? ''),
    };
    const html = pending ? pending.html : clipboardData?.getData('text/html');
    if (html) data.html = html;
    // After an await the data of the event is gone
    const files = [...(clipboardData?.files ?? [])];
    data.files = await host.uploads.write(view, files);
    if (!view.alive) return;
    host.module._bl_set_clipboard(host.text(JSON.stringify(data)));
    pressKey(view, PASTE);
  });
  return { field: ime, forget };
}
