/** @internal Keyboard input for the page, and where it goes when the page lost the focus. */
export interface KeyInput {
  /** Sends the input to the page. */
  page: () => void;
  /** Delivers it to the host's focused element instead; without it the input is dropped. */
  host?: () => void;
}

/**
 * @internal Whether a keydown may come back unhandled as a browser shortcut that moves the focus:
 * every key with Ctrl, Alt or Meta and every key that types no text (Tab, Escape, F-keys, arrows),
 * but not typing (a character or Space with or without Shift, Enter, Backspace, Delete).
 */
export function mayBeShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>) {
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') return false;
  return [...e.key].length !== 1;
}

/**
 * @internal Keyboard input of a view in its order, like Chrome's input router: while a keydown
 * that may be a browser shortcut (`mayBeShortcut`) waits for the engine's answer (`key-result`),
 * later keyboard input waits in the host. The page may not handle that keydown and the host run
 * a browser shortcut for it that moves the focus (Ctrl+L to the address bar, Ctrl+F to the find
 * bar), so the input held meanwhile goes on to whatever has the focus after the answer: the page
 * while its view still has the focus, else the host's focused element. Typing goes on without
 * waiting, so after the engine was busy the keys held meanwhile reach it at once up to the next
 * possible shortcut, not one engine round trip per key.
 */
export class KeyQueue {
  /** Sent keydowns that wait for their answer, in order: true for a possible shortcut. */
  private readonly sentKeys: boolean[] = [];
  private shortcuts = 0;
  private readonly held: KeyInput[] = [];

  /** @param focused Whether the view still has the keyboard focus. */
  constructor(private readonly focused: () => boolean) {}

  /** Runs the input now, or holds it while a sent possible shortcut waits for its answer. */
  run(input: KeyInput): void {
    if (this.shortcuts || this.held.length) this.held.push(input);
    else input.page();
  }

  /** A keydown went to the engine; its answer comes as `answered`. */
  sent(shortcut: boolean): void {
    this.sentKeys.push(shortcut);
    if (shortcut) this.shortcuts++;
  }

  /** The engine answered the oldest sent keydown (after the shortcut of an unhandled one ran). */
  answered(): void {
    if (this.sentKeys.shift()) this.shortcuts--;
    while (!this.shortcuts && this.held.length) {
      const input = this.held.shift() as KeyInput;
      if (this.focused()) input.page();
      else input.host?.();
    }
  }

  /** The view closed: held input is dropped. */
  clear(): void {
    this.sentKeys.length = 0;
    this.shortcuts = 0;
    this.held.length = 0;
  }
}

type KeyFields = Pick<
  KeyboardEvent,
  'key' | 'code' | 'keyCode' | 'location' | 'repeat' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
>;

function editableHostElement(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) return !element.readOnly && !element.disabled;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * @internal Edits the host's focused field like typing: inserts `text` after `backspaces`
 * deletions, with the field's own undo and input events. Nothing without an editable element.
 */
export function editHostField(backspaces: number, text: string): void {
  if (!editableHostElement()) return;
  for (let i = 0; i < backspaces; i++) document.execCommand('delete');
  if (text) document.execCommand('insertText', false, text);
}

/**
 * @internal Delivers a held key event to the host's focused element: its listeners get the same
 * event (the host's shortcuts, Enter and Escape of its fields) and a keydown they do not prevent
 * edits a field like typing (characters, Backspace, Delete). Another view's keyboard field takes it
 * on to that page.
 */
export function keyToHost(type: 'keydown' | 'keyup', e: KeyFields): void {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent(type, {
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    location: e.location,
    repeat: e.repeat,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  if (!target.dispatchEvent(event) || type !== 'keydown' || e.ctrlKey || e.metaKey) return;
  if ([...e.key].length === 1) editHostField(0, e.key);
  else if (e.key === 'Backspace') editHostField(1, '');
  else if (e.key === 'Delete' && editableHostElement()) document.execCommand('forwardDelete');
}
