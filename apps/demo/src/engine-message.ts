import type { StartProgress } from '@browser-lite/core';
import { byId } from './util.js';

const box = byId('boot');
const card = box.querySelector('.boot-card') as HTMLElement;
let note = '';

/** Replaces what the message over the page area shows and shows it. */
export function showBoot(...nodes: Node[]): void {
  card.replaceChildren(...nodes);
  box.hidden = false;
}

/** The question for the access code (access.ts) stays until it is answered. */
const asking = () => box.dataset.access === 'ask';

/**
 * Message over the page area: loading, errors at the start, crash and hang of the engine.
 * The last action is the primary one.
 */
export function showMessage(
  text: string,
  details: string[] = [],
  actions: [label: string, action: () => void][] = [],
): void {
  if (asking()) return;
  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = text;
  const nodes: Node[] = [title];
  for (const line of details) {
    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = line;
    nodes.push(detail);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', action);
      row.append(button);
    }
    (row.lastChild as HTMLElement).className = 'primary';
    nodes.push(row);
  }
  showBoot(...nodes);
}

/** Progress of the start: a bar while the engine downloads, then "Starting engine". */
export function showStartProgress({ phase, loaded, total }: StartProgress): void {
  if (asking()) return;
  if (phase === 'start') {
    showMessage('Starting engine…', note ? [note] : []);
    return;
  }
  let bar = box.querySelector('progress');
  if (!bar) {
    showMessage('Downloading the browser engine…', [
      'Only on the first visit and after updates, then it starts from the cache.',
      ...(note ? [note] : []),
    ]);
    bar = document.createElement('progress');
    card.append(bar);
  }
  if (total > 0) bar.value = Math.min(loaded / total, 1);
  else bar.removeAttribute('value');
}

/** A line under the start message, for example the address that opens once the engine runs. */
export function showStartNote(text: string): void {
  note = text;
  let line = box.querySelector<HTMLElement>('.note');
  if (!line) {
    line = document.createElement('p');
    line.className = 'detail note';
    card.querySelector('progress')?.before(line) ?? card.append(line);
  }
  line.textContent = text;
}

export function hideMessage(): void {
  if (asking()) return;
  box.hidden = true;
}
