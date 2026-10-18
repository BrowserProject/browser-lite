import type { Rect, View } from '@browser-lite/core';
import { resolveTexts, type UiTexts } from './texts.js';

/** Options of every ui function. */
export interface UiOptions {
  /** Element the ui elements are appended to. Default `document.body`. */
  root?: HTMLElement;
  /** Texts to replace; missing ones stay English. */
  texts?: Partial<UiTexts>;
}

/** Resolved options shared by the modules. */
export interface UiContext {
  root(): HTMLElement;
  texts: UiTexts;
}

/** Resolves the options; the root is looked up when needed, so a module can load before body. */
export function context(options?: UiOptions): UiContext {
  return {
    root: () => options?.root ?? document.body,
    texts: resolveTexts(options?.texts),
  };
}

/** Rectangle relative to the view canvas in viewport coordinates. */
export function viewportRect(view: View, rect: Rect): Rect {
  const canvas = view.canvas.getBoundingClientRect();
  return {
    x: canvas.left + rect.x,
    y: canvas.top + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/** Creates an element with class name and `data-bl-ui` marker. */
export function element<K extends keyof HTMLElementTagNameMap>(
  root: HTMLElement,
  tag: K,
  name: string,
): HTMLElementTagNameMap[K] {
  const node = root.ownerDocument.createElement(tag);
  node.className = `bl-${name}`;
  node.dataset.blUi = name;
  return node;
}

/**
 * Adds listeners until the returned function runs. Used for the time a popup is open, so no
 * listener stays on the document or window.
 */
export function listen(
  entries: [EventTarget, string, (event: Event) => void, boolean?][],
): () => void {
  for (const [target, type, listener, capture] of entries)
    target.addEventListener(type, listener, capture);
  return () => {
    for (const [target, type, listener, capture] of entries)
      target.removeEventListener(type, listener, capture);
  };
}
