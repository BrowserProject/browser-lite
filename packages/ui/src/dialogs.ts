import type { DialogRequest, RequestHandlers, View } from '@browser-lite/core';
import { answerAsk, decideDialog, newDialogState, skipBeforeUnload } from './dialog-guard.js';
import { context, type UiOptions } from './options.js';
import { format, hostOf } from './texts.js';

/** Options of {@link nativeDialogs}. */
export interface NativeDialogOptions extends UiOptions {
  /** Called when the user blocks further dialogs of the current document of a view. */
  onBlocked?(view: View): void;
  /** Clock for the burst protection; default `Date.now`. */
  now?(): number;
}

/** Answers when a dialog is not shown: alert nothing, confirm false, prompt null. */
function skipped(type: DialogRequest['type']): boolean | null | undefined {
  if (type === 'confirm') return false;
  if (type === 'prompt') return null;
  return undefined;
}

/**
 * alert, confirm, prompt and beforeunload with the native dialogs of the host browser, like
 * Chrome: "<host> says:" before the message, beforeunload as "Leave site?" or "Reload site?"
 * with the standard sentence (never the text of the page). When a page shows dialogs in a fast
 * loop, it asks once whether the page may show more; otherwise only the checkbox of the host
 * browser would remain, and that blocks dialogs of all pages. Blocking lasts until the view
 * gets a new document. Showing dialogs of background views is the decision of the caller
 * (wrap the handler).
 */
export function nativeDialogs(options?: NativeDialogOptions): Pick<RequestHandlers, 'dialog'> {
  const ui = context(options);
  const now = options?.now ?? Date.now;
  const states = new WeakMap<View, ReturnType<typeof newDialogState>>();
  const stateOf = (view: View) => {
    let state = states.get(view);
    if (!state) {
      const fresh = newDialogState();
      state = fresh;
      states.set(view, fresh);
      view.on('commit', () => Object.assign(fresh, newDialogState()));
    }
    return state;
  };

  return {
    dialog(request) {
      const win = ui.root().ownerDocument.defaultView ?? globalThis;
      const state = stateOf(request.view);
      const texts = ui.texts;
      if (request.type === 'beforeunload') {
        if (skipBeforeUnload(state, now())) return true;
        const question = request.reload ? texts.reloadSite : texts.leaveSite;
        const leave = win.confirm(`${question}\n\n${texts.unsavedChanges}`);
        state.last = now();
        return leave;
      }
      const host = hostOf(request.origin) || texts.thisPage;
      const decision = decideDialog(state, now());
      if (decision === 'skip') return skipped(request.type);
      if (decision === 'ask') {
        const allow = win.confirm(format(texts.manyDialogs, { host }));
        answerAsk(state, allow);
        if (!allow) {
          options?.onBlocked?.(request.view);
          return skipped(request.type);
        }
      }
      const text = `${format(texts.dialogFrom, { host })}\n\n${request.message}`;
      let result: boolean | string | null | undefined;
      if (request.type === 'confirm') result = win.confirm(text);
      else if (request.type === 'prompt') result = win.prompt(text, request.defaultValue);
      else win.alert(text);
      state.last = now();
      return result;
    },
  };
}
