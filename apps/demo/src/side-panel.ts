import { bookmarks, onBookmarksChange, toggleBookmark } from './bookmarks.js';
import { downloadState, downloads, onDownloadsChange } from './downloads.js';
import { ui } from './extensions.js';
import { favicon } from './favicons.js';
import { clearHistory, onHistoryChange, readHistory, type Visit } from './history.js';
import { type IconName, icon } from './icons.js';
import { compactLayout } from './layout.js';
import { byId, element } from './util.js';

/** Panel names; 'menu' is the menu of the toolbar, `extension:<id>` a panel of an extension. */
export type PanelName = 'menu' | 'history' | 'bookmarks' | 'downloads' | `extension:${string}`;

/** What the panel can start in the rest of the demo. */
export interface PanelActions {
  openURL(url: string, inNewTab: boolean): void;
  find(): void;
  print(): void;
  /** The settings page, at the profile and site data with 'profile'. */
  openSettings(section?: 'profile'): void;
}

const TITLES: Record<string, string> = {
  menu: 'Menu',
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
};

const panel = byId('side-panel');
const menuButton = byId('menu-button');
let current: PanelName | null = null;
let filter = '';
let actions: PanelActions;
/** Runs when the shown panel of an extension goes away. */
let leavePanel: (() => void) | undefined;

/**
 * Menu and side panel like Chrome: the menu drops down from its button (a bottom sheet on a
 * phone), history (Ctrl+H), bookmarks (Ctrl+Shift+O) and downloads (Ctrl+J) open beside the page.
 */
export function initSidePanel(panelActions: PanelActions): void {
  actions = panelActions;
  onHistoryChange(() => refresh('history'));
  onBookmarksChange(() => refresh('bookmarks'));
  onDownloadsChange(() => refresh('downloads'));
  // Shown behind the menu and, in the phone layout, behind every sheet
  byId('sheet-backdrop').addEventListener('click', () => togglePanel(null));
  panel.addEventListener('keydown', moveInMenu);
  ui.on('open-panel', ({ id }) => {
    if (current !== `extension:${id}`) togglePanel(`extension:${id}`);
  });
  ui.on('change', ({ slot }) => {
    if (slot !== 'panel') return;
    if (current?.startsWith('extension:') && !extensionPanel(current)) togglePanel(null);
    else refresh('menu');
  });
}

const extensionPanel = (name: PanelName) =>
  ui.items('panel').find((item) => `extension:${item.id}` === name);

export const panelOpen = (): boolean => current !== null;

/** Opens the panel `name`, or closes it when it is open (null closes any). */
export function togglePanel(name: PanelName | null): void {
  const wasMenu = current === 'menu';
  if (!name || name === current) {
    current = null;
    clear();
    panel.hidden = true;
    delete panel.dataset.panel;
    menuButton.setAttribute('aria-expanded', 'false');
    // Back to the menu button when the keyboard was in the menu
    if (wasMenu && panel.contains(document.activeElement)) menuButton.focus();
    return;
  }
  current = name;
  filter = '';
  panel.dataset.panel = name.startsWith('extension:') ? 'extension' : name;
  menuButton.setAttribute('aria-expanded', String(name === 'menu'));
  panel.hidden = false;
  render();
}

function refresh(name: PanelName): void {
  if (current === name) render();
}

/** Arrow keys, Home and End move between the items of the menu. */
function moveInMenu(e: KeyboardEvent): void {
  if (current !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
  e.preventDefault();
}

function linkRow(entry: { url: string; title: string }, extra: HTMLElement | null): HTMLElement {
  const row = element('div', { className: 'panel-row', title: entry.url });
  const open = element(
    'button',
    { className: 'panel-link' },
    favicon(entry.url),
    element(
      'span',
      { className: 'panel-text' },
      element('span', { className: 'panel-title', textContent: entry.title || entry.url }),
      element('span', { className: 'panel-url', textContent: entry.url }),
    ),
  );
  open.addEventListener('click', (e) => actions.openURL(entry.url, e.ctrlKey || e.metaKey));
  open.addEventListener('auxclick', (e) => {
    if (e.button === 1) actions.openURL(entry.url, true);
  });
  row.append(open);
  if (extra) row.append(extra);
  return row;
}

/** An icon button with its label below, for the row at the top of the phone menu. */
function quickAction(sourceId: string): HTMLButtonElement {
  const source = byId<HTMLButtonElement>(sourceId);
  const label =
    sourceId === 'bookmark'
      ? source.classList.contains('active')
        ? 'Bookmarked'
        : 'Bookmark'
      : source.title;
  const button = element('button', {
    className: 'panel-icon',
    type: 'button',
    title: source.title,
    disabled: source.disabled,
  });
  const svg = source.querySelector('.ui-icon');
  if (svg) button.append(svg.cloneNode(true));
  button.append(element('span', { textContent: label }));
  button.classList.toggle('active', source.classList.contains('active'));
  button.addEventListener('click', () => {
    togglePanel(null);
    source.click();
  });
  return button;
}

function renderMenu(): void {
  const close = (run: () => void) => () => {
    togglePanel(null);
    run();
  };
  // The toolbar buttons the phone layout hides
  panel.append(
    element(
      'div',
      { className: 'panel-toolbar' },
      ...['forward', 'reload', 'bookmark'].map(quickAction),
    ),
  );
  const items: [string, string, IconName, string, () => void][] = [
    ['new-tab', 'New tab', 'plus', 'Ctrl+T', close(() => actions.openURL('', true))],
    ['history', 'History', 'history', 'Ctrl+H', () => togglePanel('history')],
    ['bookmarks', 'Bookmarks', 'bookmarks', 'Ctrl+Shift+O', () => togglePanel('bookmarks')],
    ['downloads', 'Downloads', 'download', 'Ctrl+J', () => togglePanel('downloads')],
    ['find', 'Find in page', 'search', 'Ctrl+F', close(() => actions.find())],
    ['print', 'Print…', 'print', 'Ctrl+P', close(() => actions.print())],
    ...ui
      .items('panel')
      .map((item): [string, string, IconName, string, () => void] => [
        `extension:${item.id}`,
        item.title,
        'extension',
        '',
        () => togglePanel(`extension:${item.id}`),
      ]),
    [
      'profile',
      'Profile and site data',
      'profile',
      '',
      close(() => actions.openSettings('profile')),
    ],
    ['settings', 'Settings', 'settings', '', close(() => actions.openSettings())],
  ];
  const list = element('div', { className: 'panel-menu' });
  list.setAttribute('role', 'menu');
  for (const [id, label, name, key, action] of items) {
    if (id === 'profile') list.append(element('hr', { className: 'panel-separator' }));
    const button = element(
      'button',
      { className: 'panel-menu-item', type: 'button' },
      icon(name),
      element('span', { className: 'panel-menu-label', textContent: label }),
    );
    if (key) button.append(element('kbd', { textContent: key }));
    button.dataset.item = id;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', action);
    list.append(button);
  }
  panel.append(list);
}

/** "Today", "Yesterday" or the date of a day in the history. */
function dayLabel(time: number): string {
  const day = new Date(time).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return 'Today';
  if (today - day <= 86400000 * 1.5) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * The history newest first, grouped by day with the time of the visit; a page visited again on
 * the same day shows once, at its latest visit.
 */
function renderHistory(list: HTMLElement, visits: Visit[]): number {
  let day = '';
  let seen = new Set<string>();
  let shown = 0;
  for (const visit of visits) {
    const label = dayLabel(visit.time);
    if (label !== day) {
      day = label;
      seen = new Set();
      list.append(element('h3', { className: 'panel-day', textContent: label }));
    }
    if (seen.has(visit.url)) continue;
    seen.add(visit.url);
    const time = new Date(visit.time).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const row = linkRow(visit, null);
    row.prepend(element('span', { className: 'panel-time', textContent: time }));
    list.append(row);
    if (++shown >= 300) break;
  }
  return shown;
}

function renderLinks(name: 'history' | 'bookmarks'): void {
  const search = element('input', {
    type: 'search',
    className: 'panel-search',
    placeholder: name === 'history' ? 'Search history' : 'Search bookmarks',
    value: filter,
  });
  search.setAttribute('aria-label', search.placeholder);
  const list = element('div', { className: 'panel-list' });
  panel.append(search, list);
  const renderList = () => {
    list.textContent = '';
    const query = filter.trim().toLowerCase();
    const matches = (entry: { url: string; title: string }) =>
      !query ||
      entry.url.toLowerCase().includes(query) ||
      entry.title.toLowerCase().includes(query);
    let shown = 0;
    if (name === 'history') {
      shown = renderHistory(list, readHistory().slice().reverse().filter(matches));
    } else {
      for (const entry of bookmarks().slice().reverse().filter(matches).slice(0, 300)) {
        const remove = element('button', {
          className: 'panel-remove',
          type: 'button',
          title: 'Remove bookmark',
        });
        remove.setAttribute('aria-label', `Remove ${entry.title || entry.url}`);
        remove.append(icon('close'));
        remove.addEventListener('click', () => toggleBookmark(entry.url));
        list.append(linkRow(entry, remove));
        shown++;
      }
    }
    if (!shown)
      list.append(
        element('p', {
          className: 'panel-empty',
          textContent: query
            ? 'Nothing found.'
            : name === 'history'
              ? 'No history yet.'
              : 'No bookmarks yet. The star in the address bar adds one.',
        }),
      );
  };
  search.addEventListener('input', () => {
    filter = search.value;
    renderList();
  });
  if (name === 'history') {
    const clear = element('button', {
      className: 'panel-action',
      type: 'button',
      textContent: 'Clear history',
    });
    clear.addEventListener('click', () => {
      if (confirm('Clear the whole history?')) clearHistory();
    });
    panel.append(clear);
  }
  renderList();
  // On a phone the keyboard would cover half of the sheet before the user wants to search
  if (!compactLayout()) search.focus();
}

function renderDownloads(): void {
  const list = element('div', { className: 'panel-list' });
  for (const entry of downloads().slice().reverse()) {
    const row = element(
      'div',
      { className: 'panel-row panel-download' },
      icon('download'),
      element(
        'span',
        { className: 'panel-text' },
        element('span', { className: 'panel-title', textContent: entry.filename }),
        element('span', { className: 'panel-url', textContent: downloadState(entry) }),
      ),
    );
    const download = entry.download;
    if (download?.state === 'done') {
      const save = element('button', {
        className: 'panel-action',
        type: 'button',
        textContent: 'Save again',
      });
      save.addEventListener('click', () => download.save());
      row.append(save);
    }
    list.append(row);
  }
  if (!downloads().length)
    list.append(element('p', { className: 'panel-empty', textContent: 'No downloads yet.' }));
  panel.append(list);
}

function clear(): void {
  const leave = leavePanel;
  leavePanel = undefined;
  try {
    leave?.();
  } catch (error) {
    console.warn('extension panel:', error);
  }
  panel.textContent = '';
}

function renderExtension(name: PanelName): void {
  const item = extensionPanel(name);
  const container = element('div', { className: 'panel-extension' });
  if (item) container.dataset.blItem = item.id;
  panel.append(container);
  try {
    leavePanel = item?.render(container);
  } catch (error) {
    console.warn('extension panel:', error);
  }
}

function render(): void {
  if (!current) return;
  clear();
  if (current === 'menu') {
    renderMenu();
    return;
  }
  const close = element('button', { className: 'panel-close', type: 'button', title: 'Close' });
  close.setAttribute('aria-label', 'Close');
  close.append(icon('close'));
  close.addEventListener('click', () => togglePanel(null));
  const title = TITLES[current] ?? extensionPanel(current)?.title ?? '';
  panel.append(element('header', {}, element('h2', { textContent: title }), close));
  if (current === 'downloads') renderDownloads();
  else if (current === 'history' || current === 'bookmarks') renderLinks(current);
  else renderExtension(current);
}
