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
