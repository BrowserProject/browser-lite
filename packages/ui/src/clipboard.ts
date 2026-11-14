import type { PasteContent } from '@browser-lite/core';

/**
 * Text and HTML of the host clipboard for Paste of the context menu, like Chrome pastes rich
 * text from its menu: `navigator.clipboard.read()`, `readText()` where that is missing. Null
 * when there is no clipboard or reading it was denied.
 */
export async function readHostClipboard(): Promise<PasteContent | null> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) return null;
  if (typeof clipboard.read !== 'function')
    return clipboard.readText().then(
      (text) => ({ text }),
      () => null,
    );
  try {
    const items = await clipboard.read();
    const read = async (type: string) => {
      const item = items.find((entry) => entry.types.includes(type));
      return item ? (await item.getType(type)).text() : '';
    };
    const [text, html] = await Promise.all([read('text/plain'), read('text/html')]);
    return html ? { text, html } : { text };
  } catch {
    return null;
  }
}
