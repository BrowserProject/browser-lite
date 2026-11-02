import type { DialogAnswer, DialogRequest, RequestHandlers, View } from '@browser-lite/core';
import { type DialogContent, type DialogOptions, guardedDialogs } from './dialogs.js';
import { context, element } from './options.js';

interface Pending {
  content: DialogContent;
  request: DialogRequest;
  resolve(answer: DialogAnswer): void;
  form: HTMLFormElement | null;
}

/** The answer of the button that declines (Escape, abort). */
const declined = (content: DialogContent): DialogAnswer =>
  content.type === 'alert' ? undefined : content.type === 'prompt' ? null : false;

/**
 * alert, confirm, prompt and beforeunload as dialogs in the page of the host, with the texts and
 * the protection against loops of {@link nativeDialogs}. Only the asking page waits for the
 * answer (the core runs the other views meanwhile). One dialog per view at a time, the others of
 * that view wait in order; an aborted request (navigation, closing) removes its dialog. Enter
 * accepts, Escape declines; the focus goes to the field or the accepting button and back to the
 * view afterwards. Element: `.bl-page-dialog` (a form) with `data-bl-view` and `data-bl-type`,
 * `h2`, `p.bl-message`, `input` (prompt), `button.bl-cancel` and `button.bl-ok`
 * (`data-bl-answer=cancel|ok`). Showing dialogs of background views is the decision of the
 * caller (wrap the handler, or hide the elements of views that are not shown).
 */
export function pageDialogs(options?: DialogOptions): Pick<RequestHandlers, 'dialog'> {
  const ui = context(options);
  const queues = new Map<View, Pending[]>();

  const render = (pending: Pending) => {
    const { content, request } = pending;
    const root = ui.root();
    const doc = root.ownerDocument;
    const form = element(root, 'form', 'page-dialog');
    form.setAttribute('role', 'alertdialog');
    form.setAttribute('aria-label', content.title || content.message.slice(0, 100));
    form.dataset.blView = String(request.view.id);
    form.dataset.blType = content.type;
    if (content.title) {
      const title = doc.createElement('h2');
      title.textContent = content.title;
      form.append(title);
    }
    if (content.message) {
      const message = element(root, 'p', 'message');
      message.textContent = content.message;
      form.append(message);
    }
    let input: HTMLInputElement | null = null;
    if (content.type === 'prompt') {
      input = doc.createElement('input');
      input.type = 'text';
      input.value = content.defaultValue;
      form.append(input);
    }
    const actions = element(root, 'div', 'actions');
    if (content.cancel !== null) {
      const cancel = element(root, 'button', 'cancel');
      cancel.type = 'button';
      cancel.dataset.blAnswer = 'cancel';
      cancel.textContent = content.cancel;
      cancel.addEventListener('click', () => finish(pending, declined(content)));
      actions.append(cancel);
    }
    const ok = element(root, 'button', 'ok');
    ok.type = 'submit';
    ok.dataset.blAnswer = 'ok';
    ok.textContent = content.ok;
    actions.append(ok);
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(pending, content.type === 'alert' ? undefined : input ? input.value : true);
    });
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(pending, declined(content));
    });
    pending.form = form;
    root.append(form);
    if (input) {
      input.focus({ preventScroll: true });
      input.select();
    } else {
      ok.focus({ preventScroll: true });
    }
  };

  const finish = (pending: Pending, answer: DialogAnswer) => {
    const view = pending.request.view;
    const queue = queues.get(view) ?? [];
    const index = queue.indexOf(pending);
    if (index < 0) return;
    queue.splice(index, 1);
    if (!queue.length) queues.delete(view);
    const form = pending.form;
    const doc = form?.ownerDocument;
    const focused = !!form && !!doc && form.contains(doc.activeElement);
    form?.remove();
    pending.resolve(answer);
    const next = queue[0];
    if (index === 0 && next) render(next);
    else if (focused && !view.closed) view.focus();
  };

  return guardedDialogs(
    options,
    (content, request) =>
      new Promise<DialogAnswer>((resolve) => {
        if (request.signal.aborted) {
          resolve(declined(content));
          return;
        }
        const pending: Pending = { content, request, resolve, form: null };
        let queue = queues.get(request.view);
        if (!queue) {
          queue = [];
          queues.set(request.view, queue);
        }
        queue.push(pending);
        request.signal.addEventListener('abort', () => finish(pending, declined(content)), {
          once: true,
        });
        if (queue.length === 1) render(pending);
      }),
  );
}
