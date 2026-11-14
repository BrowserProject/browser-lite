import type { ContextMenuInfo, PasteContent, View } from '@browser-lite/core';
import { readHostClipboard } from './clipboard.js';
import type { MenuItem } from './context-menu.js';
import type { UiOptions } from './options.js';
import { format, resolveTexts } from './texts.js';
import { displayURL } from './url-display.js';

/** The search engine of Search ... for "..." (`texts.searchFor`). */
export interface MenuSearch {
  /** Name in the label, for example `Google`. */
  engine: string;
  /** Opens the search for the selected text; Chrome opens it in a new tab in front. */
  open(text: string): void;
}

/** Actions of the standard menu that need the app; the optional ones default to the view. */
export interface MenuActions {
  /** Opens a link or image in a new tab; Chrome opens it in the background. */
  openTab(url: string): void;
  /** Search for selected text like Chrome; without it the menu has no search item. */
  search?: MenuSearch;
  /** Default `view.reload()`. */
  reload?(): void;
  /** Default `view.print()`. */
  print?(): void;
  /** Default `view.viewSource()`. */
  viewSource?(): void;
  /** Save link as, Save image as; default `view.download()`. */
  download?(url: string): void;
  /** Writes text to the clipboard; default `navigator.clipboard.writeText`. */
  copyText?(text: string): void | Promise<void>;
  /**
   * Reads the clipboard for Paste and Paste as plain text; default `navigator.clipboard.read()`
   * (text and HTML) or `readText()`, null when denied: then they paste the engine clipboard.
   */
  readClipboard?(): Promise<PasteContent | null>;
}

// Like Chrome's kMaxSelectionTextLength: the label shows at most 50 characters of the selection
const SEARCH_LABEL_LENGTH = 50;

/** Selected text as Chrome searches for it: white space collapsed, '' when there is none. */
function searchText(selection: string): string {
  return selection.replace(/\s+/g, ' ').trim();
}

/** Shortens text for a label at a word break where there is one, like gfx::TruncateString. */
function shorten(text: string, length: number): string {
  const chars = Array.from(text);
  if (chars.length <= length) return text;
  const cut = chars.slice(0, length - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The standard items of a context menu like Chrome: open, save and copy the address of a link or
 * image, copy an image, copy, search the web for the selection (with `actions.search`), select
 * all, back, forward, reload, print and view source. In an editable field only the edit
 * commands: undo and redo (disabled without an edit to undo or redo), cut and copy (disabled
 * without a selection), paste, paste as plain text, select all and the search. After a long
 * press (`info.touch`) like Chrome on phones only what was pressed: the address of the link or
 * image as a header and its commands, cut, copy, paste and select all in a field or copy and
 * select all for text, the search for a selection, nothing else (no menu on plain page). Pass
 * them to {@link showContextMenu}, possibly with own items added.
 */
export function defaultMenuItems(
  view: View,
  info: ContextMenuInfo,
  actions: MenuActions,
  options?: Pick<UiOptions, 'texts'>,
): MenuItem[] {
  const texts = resolveTexts(options?.texts);
  const copyText = (text: string) =>
    actions.copyText ? actions.copyText(text) : globalThis.navigator?.clipboard?.writeText(text);
  const download = (url: string) => (actions.download ? actions.download(url) : view.download(url));
  const readClipboard = () =>
    actions.readClipboard ? actions.readClipboard() : readHostClipboard();
  const items: MenuItem[] = [];
  const separator = () => items.push({ separator: true });

  const pressed = info.link || info.image;
  if (info.touch && pressed) items.push({ header: displayURL(pressed) });
  if (info.link) {
    items.push(
      { id: 'open-link', label: texts.openLinkInNewTab, action: () => actions.openTab(info.link) },
      { id: 'save-link', label: texts.saveLinkAs, action: () => download(info.link) },
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
      { id: 'save-image', label: texts.saveImageAs, action: () => download(info.image) },
      { id: 'copy-image', label: texts.copyImage, action: () => view.copyImage(info.x, info.y) },
      {
        id: 'copy-image-address',
        label: texts.copyImageAddress,
        action: () => copyText(info.image),
      },
    );
    separator();
  }
  const copy: MenuItem = { id: 'copy', label: texts.copy, action: () => view.command('Copy') };
  const query = actions.search ? searchText(info.selection) : '';
  const search = (): MenuItem[] =>
    actions.search && query
      ? [
          {
            id: 'search',
            label: format(texts.searchFor, {
              engine: actions.search.engine,
              text: shorten(query, SEARCH_LABEL_LENGTH),
            }),
            action: () => actions.search?.open(query),
          },
        ]
      : [];
  const selectAll: MenuItem = {
    id: 'select-all',
    label: texts.selectAll,
    action: () => view.command('SelectAll'),
  };
  if (info.editable) {
    if (!info.touch) {
      items.push(
        {
          id: 'undo',
          label: texts.undo,
          action: () => view.command('Undo'),
          enabled: info.canUndo,
        },
        {
          id: 'redo',
          label: texts.redo,
          action: () => view.command('Redo'),
          enabled: info.canRedo,
        },
      );
      separator();
    }
    items.push(
      {
        id: 'cut',
        label: texts.cut,
        action: () => view.command('Cut'),
        enabled: !!info.selection,
      },
      { ...copy, enabled: !!info.selection },
      {
        id: 'paste',
        label: texts.paste,
        async action() {
          const content = await readClipboard();
          if (content) view.paste(content);
          else view.command('Paste');
        },
      },
    );
    if (!info.touch)
      items.push({
        id: 'paste-plain',
        label: texts.pasteAsPlainText,
        async action() {
          const content = await readClipboard();
          if (content) view.paste(content.text);
          else view.command('PasteAndMatchStyle');
        },
      });
    items.push(selectAll);
    separator();
    items.push(...search());
    return items;
  }
  if (info.selection) items.push(copy, ...search());
  if (!info.touch || info.selection) items.push(selectAll);
  if (info.touch) return items;
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
