import type { AuthCredentials, AuthRequest, RequestHandlers } from '@browser-lite/core';
import { context, element, type UiOptions } from './options.js';

interface Pending {
  request: AuthRequest;
  resolve(answer: AuthCredentials | null): void;
  onAbort(): void;
}

/**
 * Asks like Chrome's sign-in dialog: "Sign in", the origin of the server, for plain http the
 * warning that the connection is not private, user name, password, Cancel and Sign in. Like
 * Chrome it does not show the realm, a text the server chooses. One dialog at a time, the others
 * wait in order; an aborted request leaves the queue. Enter signs in, Escape cancels. Element:
 * `.bl-login-prompt` (a form) with `h2`, `p.bl-origin`, `p.bl-not-private`, `input[name=username]`,
 * `input[name=password]` and `button[data-bl-answer=cancel|sign-in]`.
 */
export function loginPrompt(options?: UiOptions): Pick<RequestHandlers, 'authenticate'> {
  const ui = context(options);
  const queue: Pending[] = [];
  let shown: { pending: Pending; form: HTMLFormElement } | null = null;

  const showNext = () => {
    const pending = queue[0];
    if (shown || !pending) return;
    const { request } = pending;
    const root = ui.root();
    const doc = root.ownerDocument;
    const texts = ui.texts;
    const form = element(root, 'form', 'login-prompt');
    form.setAttribute('role', 'dialog');
    form.dataset.blView = String(request.view.id);
    const title = doc.createElement('h2');
    title.textContent = texts.signIn;
    const origin = element(root, 'p', 'origin');
    origin.textContent = request.origin;
    form.append(title, origin);
    if (request.origin.startsWith('http:')) {
      const warning = element(root, 'p', 'not-private');
      warning.textContent = texts.notPrivate;
      form.append(warning);
    }
    const field = (name: 'username' | 'password', label: string) => {
      const wrapper = doc.createElement('label');
      const input = doc.createElement('input');
      input.name = name;
      input.type = name === 'password' ? 'password' : 'text';
      input.autocomplete = name === 'password' ? 'current-password' : 'username';
      wrapper.append(label, input);
      form.append(wrapper);
      return input;
    };
    const username = field('username', texts.username);
    const password = field('password', texts.password);
    const button = (answer: 'cancel' | 'sign-in', label: string) => {
      const node = element(root, 'button', answer);
      node.type = answer === 'sign-in' ? 'submit' : 'button';
      node.dataset.blAnswer = answer;
      node.textContent = label;
      return node;
    };
    const cancel = button('cancel', texts.cancel);
    cancel.addEventListener('click', () => answerShown(null));
    form.append(cancel, button('sign-in', texts.signIn));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      answerShown({ username: username.value, password: password.value });
    });
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      answerShown(null);
    });
    shown = { pending, form };
    root.append(form);
    username.focus();
  };

  const remove = (pending: Pending) => {
    const position = queue.indexOf(pending);
    if (position >= 0) queue.splice(position, 1);
    if (shown?.pending === pending) {
      shown.form.remove();
      shown = null;
    }
  };

  const answerShown = (answer: AuthCredentials | null) => {
    if (!shown) return;
    const { pending } = shown;
    remove(pending);
    pending.request.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(answer);
    showNext();
  };

  return {
    authenticate(request) {
      return new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve(null);
          return;
        }
        const pending: Pending = {
          request,
          resolve,
          onAbort: () => {
            remove(pending);
            resolve(null);
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
