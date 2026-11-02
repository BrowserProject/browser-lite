import { showBoot } from './engine-message.js';
import { relayUrl, setToken } from './params.js';
import { reloadUI } from './reload.js';
import { byId, element } from './util.js';

let shown = false;

/**
 * The relay refused the access token (missing or no longer valid): asks for the access code of
 * this server instead of the error pages of a lost connection, stores it and starts again.
 */
export function askForAccessCode(): void {
  if (shown) return;
  shown = true;
  const input = element('input', {
    type: 'password',
    id: 'access-code',
    placeholder: 'Access code',
    autocomplete: 'current-password',
    required: true,
  });
  input.setAttribute('aria-label', 'Access code');
  const form = element(
    'form',
    { className: 'access-form' },
    input,
    element('button', { type: 'submit', className: 'primary', textContent: 'Continue' }),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    setToken(relayUrl.host, code);
    reloadUI();
  });
  byId('boot').dataset.access = 'ask';
  showBoot(
    element('p', { className: 'title', textContent: 'This server needs an access code' }),
    element('p', {
      className: 'detail',
      textContent:
        'The code is missing or no longer valid. Enter the code you got for this server, or open the link with the code again.',
    }),
    form,
  );
  input.focus();
}
