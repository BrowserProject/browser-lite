import { byId } from './util.js';

const box = byId('boot');

/**
 * Message over the page area: loading, errors at the start, crash and hang of the engine.
 * The last action is the primary one.
 */
export function showMessage(
  text: string,
  details: string[] = [],
  actions: [label: string, action: () => void][] = [],
): void {
  const title = document.createElement('p');
  title.textContent = text;
  box.replaceChildren(title);
  for (const line of details) {
    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = line;
    box.append(detail);
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
    box.append(row);
  }
  box.hidden = false;
}

export function hideMessage(): void {
  box.hidden = true;
}
