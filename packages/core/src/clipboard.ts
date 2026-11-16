import type { ClipboardContent, ClipboardWriteRequest } from './types.js';

/**
 * Default of the handler `clipboardWrite`: the clipboard of the host, with HTML like Chrome. An
 * image is written before its data arrived, still in the click (Safari allows it only there).
 */
export async function writeHostClipboard({
  text,
  html,
  image,
}: ClipboardWriteRequest): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  if (image) {
    if (typeof ClipboardItem !== 'function') return;
    await clipboard.write([new ClipboardItem({ 'image/png': image })]);
    return;
  }
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

/**
 * Default of the handler `clipboardRead`: the clipboard of the host with text, HTML and a PNG
 * like Chrome's `navigator.clipboard.read()`, only the text where the host has only `readText()`.
 * Null when the host refuses (no permission, no user activation, the user dismissed its Paste).
 */
export async function readHostClipboard(): Promise<ClipboardContent | null> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return null;
  try {
    if (typeof clipboard.read !== 'function') return { text: await clipboard.readText(), html: '' };
    const content: ClipboardContent = { text: '', html: '' };
    const read = async (item: ClipboardItem, type: string) =>
      item.types.includes(type) ? item.getType(type) : null;
    for (const item of await clipboard.read()) {
      content.text ||= (await (await read(item, 'text/plain'))?.text()) ?? '';
      content.html ||= (await (await read(item, 'text/html'))?.text()) ?? '';
      content.image ??= (await read(item, 'image/png')) ?? undefined;
    }
    return content;
  } catch {
    return null;
  }
}
