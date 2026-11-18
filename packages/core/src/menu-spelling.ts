import type { ContextMenuSpelling } from './types.js';

/** `spelling` of the engine's 'context-menu' event as {@link ContextMenuSpelling}, null without one. */
export function menuSpelling(value: unknown): ContextMenuSpelling | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const word = String(data.word ?? '');
  if (!word) return null;
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions.map(String) : [];
  return { word, suggestions };
}
