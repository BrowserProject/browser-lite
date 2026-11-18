import { pendingClipboardWrite } from './clipboard.js';
import { modifierBits } from './input.js';
import { editHostField, keyToHost, mayBeShortcut } from './key-queue.js';
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

/** @internal Focused field of the page for the on-screen keyboard (engine event "text-input"). */
export interface TextInput {
  /** Input mode, `none` without a field that takes text. */
  mode: string;
  /** The field's `enterkeyhint`, empty without one. */
  enterKeyHint: string;
  /** A text field, not a text area or editable element. */
  singleLine: boolean;
  /** A single line field that a next field of its form follows. */
  nextField: boolean;
  /** The field's used `autocapitalize` hint: `none`, `sentences`, `words` or `characters`. */
  autocapitalize: string;
  /** The field's used `autocorrect` state. */
  autocorrect: boolean;
  /** The field's `spellcheck` state. */
  spellcheck: boolean;
}

/** @internal The focused field of the engine event "text-input". */
export function textInputOf(data: Record<string, unknown>): TextInput {
  return {
    mode: String(data.mode ?? '') || 'none',
    enterKeyHint: String(data.enterKeyHint ?? ''),
    singleLine: data.singleLine === true,
    nextField: data.nextField === true,
    autocapitalize: String(data.autocapitalize ?? '') || 'none',
    autocorrect: data.autocorrect === true,
    spellcheck: data.spellcheck === true,
  };
}

/**
 * @internal What the host's on-screen keyboard takes from the IME field for the page's focused
 * field: its enter key and its text hints. The keyboard gives a field a capital at the start of a
 * sentence, corrections and suggestions only when the hints allow them.
 */
export interface ImeTraits {
  enterKeyHint: string;
  autocapitalize: string;
  autocorrect: boolean;
  spellcheck: boolean;
}

/** @internal The traits of the IME field for the page's focused field (`enterKeyHintOf`). */
export function imeTraitsOf(input: TextInput, nextKey: boolean): ImeTraits {
  return {
    enterKeyHint: enterKeyHintOf(input, nextKey),
    autocapitalize: input.autocapitalize,
    autocorrect: input.autocorrect,
    spellcheck: input.spellcheck,
  };
}

/**
 * @internal Enter key hint of the IME field for the page's focused field: its `enterkeyhint`,
 * else the key Chrome on Android gives it. A search field (type or `inputmode` search) gets the
 * search key: for the IME field, a textarea, input mode search alone gives the return key in
 * Gboard and "go" on iOS. A single line field gets next when a field of its form follows and the
 * host has the next key (`hasNextKey`), else go; a text area or editable element the return key.
 * The IME field is a textarea and showed the return key for every field.
 */
export function enterKeyHintOf(input: TextInput, nextKey: boolean): string {
  if (input.enterKeyHint) return input.enterKeyHint;
  if (input.mode === 'search') return 'search';
  if (!input.singleLine) return '';
  return input.nextField && nextKey ? 'next' : 'go';
}

/**
 * @internal Whether the Enter key of the on-screen keyboard moves the focus to the next field
 * instead of reaching the page, like Chrome's Next key on Android: only for the next key that
 * `enterKeyHintOf` chose, a page's own `enterkeyhint` next gets the Enter key like in Chrome.
 */
export function opensNextField(input: TextInput, nextKey: boolean): boolean {
  return !input.enterKeyHint && enterKeyHintOf(input, nextKey) === 'next';
}

/**
 * @internal Whether the host's on-screen keyboard can have a next key that moves to the next
 * field: its Enter must differ from a hardware one (`isOnScreenEnter`). iOS gives the Enter of
 * its on-screen keyboard the code Enter like a hardware key (WebKit takes the key code from the
 * character), so there a single line field gets go; its keyboard's field arrows move between
 * fields (`attachFieldArrows`).
 */
export function hasNextKey(): boolean {
  return !appleMobileHost();
}

/**
 * @internal An Enter key that comes from the action key of an on-screen keyboard: Chrome on
 * Android sends that key without a key code of a physical key (`code` empty), a hardware
 * keyboard's Enter has the code Enter and stays a key of the page.
 */
export function isOnScreenEnter(e: KeyLike): boolean {
  return e.key === 'Enter' && !e.code && !modifierBits(e);
}

/**
 * @internal The traits of the IME field (`ImeTraits`). iOS gives its on-screen keyboard the traits
 * and decides the automatic capital from the text before the caret only when an element gains
 * focus, but the IME field has the focus since the user's tap and gets the page field's traits and
 * text after it ("text-input", "caret"): the keyboard showed return instead of search in Google's
 * search box. A blur and focus of the same field in one task is no new focus there, so on iPhone
 * and iPad `refresh` moves the focus through a second field and back when the traits or the text
 * differ from those of the last focus, or the user typed since (`typed`). WebKit then starts a new
 * input session with them and keeps the keyboard open, as the focus only moves from one field to
 * another. Changes within one task lead to one such focus at most.
 */
export function imeTraits(
  ime: HTMLTextAreaElement,
  signal: AbortSignal,
): { set: (traits: ImeTraits) => void; refresh: () => void; typed: () => void } {
  const apply = (traits: ImeTraits) => {
    ime.enterKeyHint = traits.enterKeyHint;
    ime.setAttribute('autocapitalize', traits.autocapitalize);
    ime.setAttribute('autocorrect', traits.autocorrect ? 'on' : 'off');
    ime.spellcheck = traits.spellcheck;
  };
  if (!appleMobileHost()) return { set: apply, refresh: () => {}, typed: () => {} };
  const state = () =>
    [
      ime.enterKeyHint,
      ime.getAttribute('autocapitalize'),
      ime.getAttribute('autocorrect'),
      ime.spellcheck,
      ime.value,
    ].join('\n');
  // The state at the last focus, null once the keyboard typed since
  let focused: string | null = state();
  ime.addEventListener(
    'focus',
    () => {
      focused = state();
    },
    { signal },
  );
  let pending = false;
  const check = () => {
    pending = false;
    if (state() === focused || ime.inputMode === 'none' || document.activeElement !== ime) return;
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
  const refresh = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(check);
  };
  return {
    set: (traits) => {
      apply(traits);
      refresh();
    },
    refresh,
    typed: () => {
      focused = null;
    },
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

/**
 * Sends a key event (type 0 down, 1 up) to the view, in the order of its key queue: a keydown
 * that may be a shortcut holds later input there until its `key-result`.
 */
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
  if (type === 0) {
    view.keys.sent(mayBeShortcut(e));
    host.watchdog.inputSent();
  }
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

// A key that enters a character
const isCharacter = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && e.key.length === 1;
// A key that types or deletes text: the caret moves along, not elsewhere
const isTyping = (e: KeyboardEvent) =>
  isCharacter(e) || ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey);

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
 * closes; the arrows never take the focus to the host ('take-focus' is not emitted for them). Like
 * Safari's keyboard, an arrow that reaches a date, time or color field or a select opens its
 * picker: the keyboard closes there and nothing else would let the user choose.
 */
export function pressFieldArrow(view: ViewImpl, forward: boolean): void {
  view.userInput(false);
  view.keys.run({
    page: () => {
      pressKey(view, forward ? TAB : SHIFT_TAB);
      view.tabFromFieldArrow = true;
      view.host.module._bl_show_focused_picker(view.id);
    },
  });
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
 * The field holds the text before the page's caret like a real field: the page's text in the
 * caret's paragraph (the engine's "caret" event, at most 100 characters) whenever the caret moved
 * otherwise (a key, a tap, another field), then what the input method enters there. The keyboard
 * reads it for its automatic capital and its suggestions; it deletes and replaces within it
 * (Gboard's Backspace, a suggestion that replaces the word), and every change of the field reaches
 * the page as Backspaces and inserted text. In an emptied field Gboard's Backspace changed
 * nothing, so it never reached the page. The field's traits are the page field's (`imeTraits`).
 */
export function createImeField(
  view: ViewImpl,
  signal: AbortSignal,
): {
  field: HTMLTextAreaElement;
  forget: () => void;
  setContext: (before: string) => void;
  setTraits: (traits: ImeTraits) => void;
} {
  const ime = document.createElement('textarea');
  ime.setAttribute('data-bl-ime', '');
  ime.setAttribute('aria-hidden', 'true');
  ime.autocomplete = 'off';
  const traits = imeTraits(ime, signal);
  // Until the page has a field: Safari and on-screen keyboards would change the text before the
  // page gets it
  traits.set({ enterKeyHint: '', autocapitalize: 'none', autocorrect: false, spellcheck: false });
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
  // iOS decides the capital of the next letter only after text its keyboard entered itself: a
  // character of the keyboard also enters the field (the page gets it as the key, its input
  // event finds no change), so it keeps capitals for words and characters and starts a
  // sentence with one, like in a native field
  const keyboardTypes = appleMobileHost();
  // The page's text before its caret as the engine reported it last
  let context = '';
  // The field shows that text: the caret moved otherwise and the input method has not changed
  // the field since
  let following = true;
  // The caret moved without typing (a tap, an arrow key): iOS decides the capital anew at a focus
  let moved = false;
  // Entered text when the composition began: the engine shows the composition after it
  let compositionBase: string | null = null;
  // The Enter key down moved to the next field: its key up stays out of the page as well
  let nextFieldKey = false;
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
  const show = (text: string) => {
    entered = text;
    if (ime.value !== text) ime.value = text;
  };
  // The page's caret moved without the field (a key, a tap, another field): the field shows the
  // page's text before the caret, the last one known until the engine reports the new one
  const forget = (typing = false) => {
    if (composing) return;
    following = true;
    if (typing) traits.typed();
    else moved = true;
    show(context);
  };
  const setContext = (before: string) => {
    context = before;
    if (!following || composing) return;
    show(before);
    if (!moved) return;
    moved = false;
    traits.refresh();
  };
  const sync = () => {
    const { backspaces, insert } = textEdit(entered, ime.value);
    entered = ime.value;
    if (!backspaces && !insert) return;
    following = false;
    traits.typed();
    view.userInput(false);
    view.keys.run({
      page: () => {
        for (let i = 0; i < backspaces; i++) pressKey(view, BACKSPACE);
        if (insert) host.module._bl_insert_text(view.id, host.text(insert));
      },
      host: () => editHostField(backspaces, insert),
    });
  };

  // Autofill and some on-screen keyboards send key events without a key: no key to forward
  on('keydown', (e) => {
    if (typeof e.key !== 'string') return;
    // Paste: wait for the paste event, it carries the content
    if (isPasteShortcut(e) || isTextInput(e)) return;
    view.userInput(false);
    // The keyboard's character enters the field: it no longer follows the page's text, whose
    // next "caret" may come before that input
    const entersField = keyboardTypes && ime.inputMode !== 'none' && isCharacter(e);
    if (entersField) {
      following = false;
      traits.typed();
    } else forget(isTyping(e));
    if (view.nextFieldOnEnter && isOnScreenEnter(e)) {
      nextFieldKey = true;
      e.preventDefault();
      view.keys.run({ page: () => host.module._bl_focus_next_field(view.id) });
      return;
    }
    view.keys.run({ page: () => sendKey(view, 0, e), host: () => keyToHost('keydown', e) });
    if (entersField) {
      const { value, selectionStart, selectionEnd } = ime;
      entered = value.slice(0, selectionStart) + e.key + value.slice(selectionEnd);
      return;
    }
    // Browser shortcuts like Tab, Backspace and Space stay in the page
    if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
  });
  on('keyup', (e) => {
    if (typeof e.key !== 'string' || isPasteShortcut(e) || isTextInput(e)) return;
    if (nextFieldKey && e.key === 'Enter') {
      nextFieldKey = false;
      e.preventDefault();
      return;
    }
    view.keys.run({ page: () => sendKey(view, 1, e), host: () => keyToHost('keyup', e) });
    e.preventDefault();
  });
  on('compositionstart', () => {
    composing = true;
  });
  // A composition can also begin on text before the caret without compositionstart (Android
  // keyboards compose the word again on Backspace): the end corrects the text
  on('compositionupdate', (e) => {
    compositionBase ??= entered;
    following = false;
    const text = e.data || '';
    view.keys.run({
      page: () =>
        host.module._bl_set_composition(view.id, host.text(text), text.length, text.length),
    });
  });
  on('compositionend', (e) => {
    composing = false;
    view.userInput(false);
    const text = e.data || '';
    view.keys.run({
      page: () => host.module._bl_confirm_composition(view.id, host.text(text)),
      host: () => editHostField(0, text),
    });
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
    view.keys.run({
      page: () => {
        host.module._bl_set_clipboard(host.text(JSON.stringify(data)));
        pressKey(view, PASTE);
      },
      host: () => editHostField(0, String(data.text)),
    });
  });
  return { field: ime, forget: () => forget(), setContext, setTraits: traits.set };
}
