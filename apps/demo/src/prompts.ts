import type { View } from '@browser-lite/core';

// Elements of @browser-lite/ui that belong to one view and wait for the user
const SELECTOR = '.bl-page-dialog, .bl-permission-prompt, .bl-login-prompt';
let shownView = '';

const apply = (node: HTMLElement) => {
  node.hidden = node.dataset.blView !== shownView;
};

/**
 * Dialogs, permission prompts and sign-in dialogs of a view show only while its tab is in front
 * (the page waits meanwhile); `containers` are where the ui package puts them.
 */
export function followShownView(containers: HTMLElement[]): void {
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof HTMLElement && node.matches(SELECTOR)) apply(node);
  });
  for (const container of containers) observer.observe(container, { childList: true });
}

/** The view in front changed. */
export function showPromptsOf(view: View): void {
  shownView = String(view.id);
  for (const node of document.querySelectorAll<HTMLElement>(SELECTOR)) apply(node);
}

/** Moves the keyboard into the dialog of view; false when it has none. */
export function focusPrompt(view: View): boolean {
  const dialog = document.querySelector<HTMLElement>(`.bl-page-dialog[data-bl-view="${view.id}"]`);
  const target = dialog?.querySelector<HTMLElement>('input, .bl-ok');
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}
