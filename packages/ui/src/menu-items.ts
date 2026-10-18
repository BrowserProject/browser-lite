import type { ContextMenuInfo, View } from '@browser-lite/core';
import type { MenuItem } from './context-menu.js';
import type { UiOptions } from './options.js';
import { resolveTexts } from './texts.js';

/** Actions of the standard menu that need the app; the optional ones default to the view. */
export interface MenuActions {
  /** Opens a link or image in a new tab. */
  openTab(url: string): void;
  /** Default `view.reload()`. */
  reload?(): void;
  /** Default `view.print()`. */
  print?(): void;
  /** Default `view.viewSource()`. */
  viewSource?(): void;
  /** Writes text to the clipboard; default `navigator.clipboard.writeText`. */
  copyText?(text: string): void | Promise<void>;
  /** Reads the clipboard for Paste; default `navigator.clipboard.readText`, null when denied. */
  readText?(): Promise<string | null>;
}

function clipboard(): Clipboard | undefined {
  return globalThis.navigator?.clipboard;
}

/**
 * The standard items of a context menu like Chrome: open and copy link or image, copy, cut,
 * paste, select all, back, forward, reload, print and view source. Pass them to
 * {@link showContextMenu}, possibly with own items added.
 */
export function defaultMenuItems(
  view: View,
  info: ContextMenuInfo,
  actions: MenuActions,
  options?: Pick<UiOptions, 'texts'>,
): MenuItem[] {
  const texts = resolveTexts(options?.texts);
  const copyText = (text: string) =>
    actions.copyText ? actions.copyText(text) : clipboard()?.writeText(text);
  const readText = async () =>
    actions.readText
      ? actions.readText()
      : ((await clipboard()
          ?.readText()
          .catch(() => null)) ?? null);
  const items: MenuItem[] = [];
  const separator = () => items.push({ separator: true });

  if (info.link) {
    items.push(
      { id: 'open-link', label: texts.openLinkInNewTab, action: () => actions.openTab(info.link) },
      { id: 'copy-link', label: texts.copyLinkAddress, action: () => copyText(info.link) },
    );
    separator();
  }
  if (info.image) {
    items.push(
      {
        id: 'open-image',
        label: texts.openImageInNewTab,
        action: () => actions.openTab(info.image),
      },
      { id: 'copy-image', label: texts.copyImageAddress, action: () => copyText(info.image) },
    );
    separator();
  }
  if (info.selection)
    items.push({ id: 'copy', label: texts.copy, action: () => view.command('Copy') });
  if (info.editable) {
    items.push(
      {
        id: 'cut',
        label: texts.cut,
        action: () => view.command('Cut'),
        enabled: !!info.selection,
      },
      {
        id: 'paste',
        label: texts.paste,
        async action() {
          const text = await readText();
          if (text != null) view.paste(text);
          else view.command('Paste');
        },
      },
    );
  }
  items.push({ id: 'select-all', label: texts.selectAll, action: () => view.command('SelectAll') });
  separator();
  items.push(
    { id: 'back', label: texts.back, action: () => view.back(), enabled: info.canGoBack },
    {
      id: 'forward',
      label: texts.forward,
      action: () => view.forward(),
      enabled: info.canGoForward,
    },
    {
      id: 'reload',
      label: texts.reload,
      action: () => (actions.reload ?? (() => view.reload()))(),
    },
    { id: 'print', label: texts.print, action: () => (actions.print ?? (() => view.print()))() },
    {
      id: 'view-source',
      label: texts.viewSource,
      action: () => (actions.viewSource ?? (() => view.viewSource()))(),
      enabled: /^https?:/.test(view.url || ''),
    },
  );
  return items;
}
