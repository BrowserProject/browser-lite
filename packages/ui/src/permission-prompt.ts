import type { PermissionAnswer, PermissionRequest, RequestHandlers } from '@browser-lite/core';
import { context, element, type UiOptions } from './options.js';
import { format, hostOf } from './texts.js';

interface Pending {
  request: PermissionRequest;
  resolve(answer: PermissionAnswer): void;
  onAbort(): void;
}

/**
 * Asks like Chrome: "<host> wants to know your location" with Block and Allow. One question at
 * a time, the others wait in order; an aborted request leaves the queue. Block and Allow are
 * remembered by the PermissionStore of the browser. Allowing notifications also asks the host
 * browser (needs the click as user activation); when the host refuses, the answer is 'dismiss'
 * (nothing remembered, the page may ask again). Element: `.bl-permission-prompt` with `p` and
 * `button[data-bl-answer=block|allow]`.
 */
export function permissionPrompt(options?: UiOptions): Pick<RequestHandlers, 'permission'> {
  const ui = context(options);
  const queue: Pending[] = [];
  let shown: { pending: Pending; prompt: HTMLElement } | null = null;

  const showNext = () => {
    const pending = queue[0];
    if (shown || !pending) return;
    const { request } = pending;
    const root = ui.root();
    const prompt = element(root, 'div', 'permission-prompt');
    prompt.setAttribute('role', 'dialog');
    prompt.dataset.blView = String(request.view.id);
    prompt.dataset.blKind = request.kind;
    const text = root.ownerDocument.createElement('p');
    const template = ui.texts.permissions[request.kind] ?? ui.texts.permissionOther;
    text.textContent = format(template, {
      host: hostOf(request.origin) || ui.texts.thisPage,
      kind: request.kind,
    });
    const button = (answer: 'block' | 'allow', label: string) => {
      const node = element(root, 'button', answer);
      node.type = 'button';
      node.dataset.blAnswer = answer;
      node.textContent = label;
      node.addEventListener('click', () => answerShown(answer === 'allow'));
      return node;
    };
    prompt.append(text, button('block', ui.texts.block), button('allow', ui.texts.allow));
    shown = { pending, prompt };
    root.append(prompt);
  };

  const remove = (pending: Pending) => {
    const position = queue.indexOf(pending);
    if (position >= 0) queue.splice(position, 1);
    if (shown?.pending === pending) {
      shown.prompt.remove();
      shown = null;
    }
  };

  const answerShown = async (allow: boolean) => {
    if (!shown) return;
    const { pending } = shown;
    remove(pending);
    pending.request.signal.removeEventListener('abort', pending.onAbort);
    let answer: PermissionAnswer = allow ? 'grant' : 'deny';
    if (allow && pending.request.kind === 'notifications' && !(await hostNotifications()))
      answer = 'dismiss';
    pending.resolve(answer);
    showNext();
  };

  return {
    permission(request) {
      return new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve('dismiss');
          return;
        }
        const pending: Pending = {
          request,
          resolve,
          onAbort: () => {
            remove(pending);
            resolve('dismiss');
            showNext();
          },
        };
        request.signal.addEventListener('abort', pending.onAbort, { once: true });
        queue.push(pending);
        showNext();
      });
    },
  };
}

/** Pages see notifications only when the host browser shows them for this site. */
async function hostNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return true;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission().catch(() => 'denied')) === 'granted';
}
