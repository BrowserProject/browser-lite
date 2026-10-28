import type { View } from '@browser-lite/core';
import { context, element, type UiOptions } from './options.js';

/**
 * Shows the address of the link under the mouse in a bubble (bottom left by stylesheet), like
 * Chrome. Typically for the active view only. Returns a function that removes the bubble.
 * Element: `.bl-link-status`, hidden while there is no link.
 */
export function linkStatus(view: View, options?: UiOptions): () => void {
  const root = context(options).root();
  const bubble = element(root, 'div', 'link-status');
  bubble.dataset.blView = String(view.id);
  bubble.hidden = true;
  root.append(bubble);
  const show = (url: string | null) => {
    bubble.textContent = url ?? '';
    bubble.hidden = !url;
  };
  const stops = [
    view.on('hover', (event) => show(event.url)),
    // Also same-document navigations (history.pushState, back in a single page app): the link is
    // usually gone, a new one comes with the next mouse move
    view.on('navigation', () => show(null)),
    view.on('commit', () => show(null)),
    view.on('close', () => dispose()),
  ];
  const dispose = () => {
    for (const stop of stops) stop();
    bubble.remove();
  };
  return dispose;
}
