import { bookmarks, onBookmarksChange, toggleBookmark } from './bookmarks.js';
import { downloadState, downloads, onDownloadsChange } from './downloads.js';
import { clearHistory, onHistoryChange, readHistory } from './history.js';
import { byId, element, formatTime } from './util.js';

/** Panel names; 'menu' is the menu of the toolbar. */
export type PanelName = 'menu' | 'history' | 'bookmarks' | 'downloads';

/** What the panel can start in the rest of the demo. */
export interface PanelActions {
  openURL(url: string, inNewTab: boolean): void;
  find(): void;
  print(): void;
  openSettings(): void;
}

const TITLES: Record<PanelName, string> = {
  menu: 'Menu',
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
};

const panel = byId('side-panel');
let current: PanelName | null = null;
let filter = '';
let actions: PanelActions;

/** Side panel like Chrome: menu, history (Ctrl+H), bookmarks (Ctrl+Shift+O), downloads (Ctrl+J). */
export function initSidePanel(panelActions: PanelActions): void {
  actions = panelActions;
  onHistoryChange(() => refresh('history'));
  onBookmarksChange(() => refresh('bookmarks'));
  onDownloadsChange(() => refresh('downloads'));
}

export const panelOpen = (): boolean => current !== null;

/** Opens the panel `name`, or closes it when it is open (null closes any). */
export function togglePanel(name: PanelName | null): void {
  if (!name || name === current) {
    current = null;
    panel.hidden = true;
    return;
  }
  current = name;
  filter = '';
  panel.hidden = false;
  render();
}

function refresh(name: PanelName): void {
  if (current === name) render();
}

function linkRow(entry: { url: string; title: string }, extra: HTMLElement): HTMLElement {
  const row = element('div', { className: 'panel-row', title: entry.url });
  const open = element(
    'button',
    { className: 'panel-link' },
    element('span', { className: 'panel-title', textContent: entry.title || entry.url }),
    element('span', { className: 'panel-url', textContent: entry.url }),
  );
  open.addEventListener('click', (e) => actions.openURL(entry.url, e.ctrlKey || e.metaKey));
  open.addEventListener('auxclick', (e) => {
    if (e.button === 1) actions.openURL(entry.url, true);
  });
  row.append(open, extra);
  return row;
}

function renderMenu(): void {
  const close = (run: () => void) => () => {
    togglePanel(null);
    run();
  };
  const items: [string, string, () => void][] = [
    ['New tab', 'Ctrl+T', () => actions.openURL('', true)],
    ['History', 'Ctrl+H', () => togglePanel('history')],
    ['Bookmarks', 'Ctrl+Shift+O', () => togglePanel('bookmarks')],
    ['Downloads', 'Ctrl+J', () => togglePanel('downloads')],
    ['Find in page', 'Ctrl+F', close(() => actions.find())],
    ['Print…', 'Ctrl+P', close(() => actions.print())],
    ['Settings', '', close(() => actions.openSettings())],
  ];
  for (const [label, key, action] of items) {
    const button = element(
      'button',
      { className: 'panel-menu-item' },
      element('span', { textContent: label }),
      element('kbd', { textContent: key }),
    );
    button.addEventListener('click', action);
    panel.append(button);
  }
}

function renderLinks(name: 'history' | 'bookmarks'): void {
  const search = element('input', {
    type: 'search',
    className: 'panel-search',
    placeholder: 'Search',
    value: filter,
  });
  const list = element('div', { className: 'panel-list' });
  panel.append(search, list);
  const renderList = () => {
    list.textContent = '';
    const query = filter.trim().toLowerCase();
    const entries = (name === 'history' ? readHistory() : bookmarks()).slice().reverse();
    let shown = 0;
    for (const entry of entries) {
      if (
        query &&
        !(entry.url.toLowerCase().includes(query) || entry.title.toLowerCase().includes(query))
      )
        continue;
      if (++shown > 300) break;
      let extra: HTMLElement;
      if (name === 'bookmarks') {
        extra = element('button', { className: 'panel-remove', title: 'Remove', textContent: '×' });
        extra.addEventListener('click', () => toggleBookmark(entry.url));
      } else {
        extra = element('span', { className: 'panel-time', textContent: formatTime(entry.time) });
      }
      list.append(linkRow(entry, extra));
    }
    if (!shown)
      list.append(
        element('p', {
          className: 'panel-empty',
          textContent:
            name === 'history' ? 'No history yet.' : 'No bookmarks yet (star in the address bar).',
        }),
      );
  };
  search.addEventListener('input', () => {
    filter = search.value;
    renderList();
  });
  if (name === 'history') {
    const clear = element('button', { className: 'panel-action', textContent: 'Clear history' });
    clear.addEventListener('click', () => {
      if (confirm('Clear the whole history?')) clearHistory();
    });
    panel.append(clear);
  }
  renderList();
  search.focus();
}

function renderDownloads(): void {
  const list = element('div', { className: 'panel-list' });
  for (const entry of downloads().slice().reverse()) {
    const row = element(
      'div',
      { className: 'panel-row' },
      element('span', { className: 'panel-title', textContent: entry.filename }),
      element('span', { className: 'panel-time', textContent: downloadState(entry) }),
    );
    const download = entry.download;
    if (download?.state === 'done') {
      const save = element('button', { className: 'panel-action', textContent: 'Save again' });
      save.addEventListener('click', () => download.save());
      row.append(save);
    }
    list.append(row);
  }
  if (!downloads().length)
    list.append(element('p', { className: 'panel-empty', textContent: 'No downloads yet.' }));
  panel.append(list);
}

function render(): void {
  if (!current) return;
  panel.textContent = '';
  const close = element('button', {
    className: 'panel-close',
    title: 'Close',
    textContent: '×',
  });
  close.addEventListener('click', () => togglePanel(null));
  panel.append(element('header', {}, element('h2', { textContent: TITLES[current] }), close));
  if (current === 'menu') renderMenu();
  else if (current === 'downloads') renderDownloads();
  else renderLinks(current);
}
