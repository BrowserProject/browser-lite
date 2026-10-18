/**
 * New highlighted position for a navigation key of the select popup, or null when the key
 * does not navigate. `count` is the number of choosable entries.
 */
export function moveHighlight(key: string, position: number, count: number): number | null {
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(position + 1, last);
    case 'ArrowUp':
      return Math.max(position - 1, 0);
    case 'PageDown':
      return Math.min(position + 10, last);
    case 'PageUp':
      return Math.max(position - 10, 0);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/** Typing jumps to the first entry starting with the typed text; 800 ms pause starts over. */
export interface Typeahead {
  /** Adds a key; returns the matching position in `texts` (lower case) or -1. */
  type(key: string, texts: readonly string[]): number;
  reset(): void;
}

/** Creates the typeahead state of one popup. */
export function createTypeahead(pauseMs = 800): Typeahead {
  let typed = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    type(key, texts) {
      clearTimeout(timer);
      typed += key.toLowerCase();
      timer = setTimeout(() => {
        typed = '';
      }, pauseMs);
      return texts.findIndex((text) => text.startsWith(typed));
    },
    reset() {
      clearTimeout(timer);
      typed = '';
    },
  };
}
