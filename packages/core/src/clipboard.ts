import type { ClipboardWriteRequest } from './types.js';

/** Default of the handler `clipboardWrite`: the clipboard of the host, with HTML like Chrome. */
export async function writeHostClipboard({ text, html }: ClipboardWriteRequest): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  const writeText = () => clipboard.writeText(text).catch(() => {});
  if (html && typeof ClipboardItem === 'function') {
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    });
    await clipboard.write([item]).catch(writeText);
  } else await writeText();
}

// What a page copied while the write to the host clipboard is still on the way (about 16 ms in
// Chrome): a paste in that time reads the old content from the host
let pendingWrite: { text: string; html: string } | null = null;

/** Runs a write of the `clipboardWrite` handler; until it settled a paste takes its content. */
export function trackClipboardWrite(text: string, html: string, write: Promise<unknown>): void {
  const entry = { text, html };
  pendingWrite = entry;
  write.finally(() => {
    if (pendingWrite === entry) pendingWrite = null;
  });
}

/** The content of a clipboard write still on the way, null when none is. */
export const pendingClipboardWrite = (): { text: string; html: string } | null => pendingWrite;
