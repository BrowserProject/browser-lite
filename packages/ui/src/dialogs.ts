import type { DialogAnswer, DialogRequest, RequestHandlers, View } from '@browser-lite/core';
import { answerAsk, decideDialog, newDialogState, skipBeforeUnload } from './dialog-guard.js';
import { context, type UiOptions } from './options.js';
import { format, hostOf, type UiTexts } from './texts.js';

/** Options of {@link nativeDialogs} and {@link pageDialogs}. */
export interface DialogOptions extends UiOptions {
  /** Called when the user blocks further dialogs of the current document of a view. */
  onBlocked?(view: View): void;
  /** Clock for the burst protection; default `Date.now`. */
  now?(): number;
}

/** What one dialog shows; the native and the in-page dialogs render it. */
export interface DialogContent {
  /** The type of the request, 'many-dialogs' for the question about a page in a loop. */
  type: DialogRequest['type'] | 'many-dialogs';
  /** First line ("example.com says:", "Leave site?"); may be empty. */
  title: string;
  message: string;
  /** Text of the field (prompt only). */
  defaultValue: string;
  /** Label of the button that accepts. */
  ok: string;
  /** Label of the button that declines, null when there is none (alert). */
  cancel: string | null;
}

/** Shows one dialog; resolves true or false, the text of a prompt or null. */
export type ShowDialog = (
  content: DialogContent,
  request: DialogRequest,
) => DialogAnswer | Promise<DialogAnswer>;

/** Answers when a dialog is not shown: alert nothing, confirm false, prompt null. */
function skipped(type: DialogRequest['type']): boolean | null | undefined {
  if (type === 'confirm') return false;
  if (type === 'prompt') return null;
  return undefined;
}

/** Runs next with the value, after the promise when it is one (native dialogs stay synchronous). */
function after(
  value: DialogAnswer | Promise<DialogAnswer>,
  next: (value: DialogAnswer) => DialogAnswer | Promise<DialogAnswer>,
): DialogAnswer | Promise<DialogAnswer> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/** The content of a page's dialog: "<host> says:" and the message, Chrome's buttons. */
function contentOf(request: DialogRequest, texts: UiTexts): DialogContent {
  if (request.type === 'resubmit')
    return {
      type: 'resubmit',
      title: texts.resubmitForm,
      message: texts.resubmitWarning,
      defaultValue: '',
      ok: texts.resend,
      cancel: texts.cancel,
    };
  if (request.type === 'beforeunload')
    return {
      type: 'beforeunload',
      title: request.reload ? texts.reloadSite : texts.leaveSite,
      message: texts.unsavedChanges,
      defaultValue: '',
      ok: request.reload ? texts.reload : texts.leave,
      cancel: texts.cancel,
    };
  return {
    type: request.type,
    title: format(texts.dialogFrom, { host: hostOf(request.origin) || texts.thisPage }),
    message: request.message,
    defaultValue: request.defaultValue,
    ok: texts.ok,
    cancel: request.type === 'alert' ? null : texts.cancel,
  };
}

/**
 * The dialog handler around `show` with Chrome's texts and the protection against loops: when a
 * page shows dialogs in a fast loop, it asks once whether the page may show more (blocking lasts
 * until the view gets a new document); beforeunload in a navigation loop leaves without asking.
 * resubmit is the browser's own question and always shows.
 */
export function guardedDialogs(
  options: DialogOptions | undefined,
  show: ShowDialog,
): Pick<RequestHandlers, 'dialog'> {
  const { texts } = context(options);
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
      const state = stateOf(request.view);
      const showPage = () =>
        after(show(contentOf(request, texts), request), (answer) => {
          state.last = now();
          return request.type === 'beforeunload' || request.type === 'resubmit' ? !!answer : answer;
        });
      if (request.type === 'resubmit') return showPage();
      if (request.type === 'beforeunload')
        return skipBeforeUnload(state, now()) ? true : showPage();
      const decision = decideDialog(state, now());
      if (decision === 'skip') return skipped(request.type);
      if (decision === 'show') return showPage();
      const host = hostOf(request.origin) || texts.thisPage;
      const question: DialogContent = {
        type: 'many-dialogs',
        title: '',
        message: format(texts.manyDialogs, { host }),
        defaultValue: '',
        ok: texts.allow,
        cancel: texts.block,
      };
      return after(show(question, request), (answer) => {
        const allow = !!answer;
        answerAsk(state, allow);
        if (allow) return showPage();
        options?.onBlocked?.(request.view);
        return skipped(request.type);
      });
    },
  };
}

/**
 * alert, confirm, prompt, beforeunload and resubmit with the native dialogs of the host browser,
 * like Chrome: "<host> says:" before the message, beforeunload as "Leave site?" or "Reload site?"
 * with the standard sentence (never the text of the page), resubmit as "Confirm form
 * resubmission" and the protection against loops of
 * {@link guardedDialogs}. A native dialog stops the host page and so every view until the user
 * answers. Showing dialogs of background views is the decision of the caller (wrap the handler).
 */
export function nativeDialogs(options?: DialogOptions): Pick<RequestHandlers, 'dialog'> {
  const ui = context(options);
  return guardedDialogs(options, (content) => {
    const win = ui.root().ownerDocument.defaultView ?? globalThis;
    const text = [content.title, content.message].filter(Boolean).join('\n\n');
    if (content.type === 'alert') {
      win.alert(text);
      return undefined;
    }
    if (content.type === 'prompt') return win.prompt(text, content.defaultValue);
    return win.confirm(text);
  });
}
