import { bookmarks } from './bookmarks.js';
import { showStartNote } from './engine-message.js';
import { favicon, hostOf } from './favicons.js';
import { readHistory } from './history.js';
import { icon } from './icons.js';
import { compactLayout } from './layout.js';
import { runtime } from './runtime.js';
import { SEARCH_ENGINES, settings } from './settings.js';
import { activeTab, focusPage, loadInTab } from './tabs.js';
import { byId, element, isBlank } from './util.js';

const form = byId<HTMLFormElement>('address-form');
const address = byId<HTMLInputElement>('address');
const box = byId('suggestions');
/** A row of the suggestions: where it goes and what the field shows while it is selected. */
interface Row {
  url: string;
  text: string;
}
let rows: Row[] = [];
let selected = -1;
let pending = '';
/** Address of the active tab; the field shows it while it is not being edited. */
let current = '';
/** The pointer went down while the field was not focused: the click selects everything. */
let selectOnClick = false;
let preconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** The address submitted while the engine was still starting; the start opens it. */
export function takePendingAddress(): string {
  const url = pending;
  pending = '';
  return url;
}

function searchEngine() {
  return SEARCH_ENGINES[settings().searchEngine] ?? SEARCH_ENGINES.bing;
}

function searchURL(text: string): string {
  return (searchEngine()?.url ?? '').replace('%s', encodeURIComponent(text.trim()));
}

/** Text of the address bar as URL: an address, or a search with the search engine. */
export function addressToURL(text: string): string {
  const value = text.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value)) return value;
  if (/^(localhost|[^\s/]+\.[^\s/]+|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(value))
    return `https://${value}`;
  return searchURL(value);
}

/** Suggestions like Chrome: bookmarks first, then pages visited often and recently. */
export function suggestions(text: string, limit = 8): { url: string; title: string }[] {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const score = new Map<string, { url: string; title: string; points: number }>();
  const add = (url: string, title: string, points: number) => {
    const entry = score.get(url) ?? { url, title, points: 0 };
    entry.points += points;
    if (title) entry.title = title;
    score.set(url, entry);
  };
  const matches = (url: string, title: string) =>
    url
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '')
      .includes(query) || (title || '').toLowerCase().includes(query);
  for (const bookmark of bookmarks())
    if (matches(bookmark.url, bookmark.title)) add(bookmark.url, bookmark.title, 50);
  const now = Date.now();
  for (const visit of readHistory())
    if (matches(visit.url, visit.title))
      add(visit.url, visit.title, 1 + Math.max(0, 10 - (now - visit.time) / 86400000));
  return [...score.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

/** What the field shows for url when not focused: on a phone only the host, like mobile browsers. */
function shownText(url: string): string {
  if (isBlank(url)) return '';
  if (!compactLayout()) return url;
  return hostOf(url).replace(/^www\./, '') || url;
}

/** The address of the active tab changed; the field follows unless it is being edited. */
export function showAddress(url: string): void {
  current = url;
  if (document.activeElement !== address) address.value = shownText(url);
}

/** Moves the keyboard to the address bar and selects it (Ctrl+L, F6). */
export function focusAddress(): void {
  address.focus();
  address.select();
}

function hideSuggestions(): void {
  box.hidden = true;
  rows = [];
  selected = -1;
}

function select(index: number): void {
  box.children[selected]?.classList.remove('selected');
  selected = index;
  box.children[selected]?.classList.add('selected');
}

function rowElement(row: Row, start: Node, title: string, url = ''): HTMLElement {
  const node = element(
    'div',
    { className: 'suggestion' },
    start,
    element('span', { className: 'suggestion-title', textContent: title }),
  );
  if (url) node.append(element('span', { className: 'suggestion-url', textContent: url }));
  node.setAttribute('role', 'option');
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    go(row.url);
  });
  return node;
}

function showSuggestions(): void {
  const text = address.value.trim();
  box.textContent = '';
  rows = [];
  selected = -1;
  if (!text) {
    hideSuggestions();
    return;
  }
  // First what Enter does with the text: open it as an address, and always a search
  const typed = addressToURL(text);
  const search = searchURL(text);
  if (typed !== search) {
    const row = { url: typed, text };
    rows.push(row);
    box.append(rowElement(row, icon('globe'), typed));
  }
  const searchRow = { url: search, text };
  rows.push(searchRow);
  box.append(
    rowElement(searchRow, icon('search'), `Search ${searchEngine()?.name ?? ''} for "${text}"`),
  );
  for (const entry of suggestions(text)) {
    if (entry.url === typed) continue;
    const row = { url: entry.url, text: entry.url };
    rows.push(row);
    box.append(rowElement(row, favicon(entry.url), entry.title || entry.url, entry.url));
  }
  select(0);
  if (compactLayout()) {
    // Full width under the toolbar, like the suggestions of mobile browsers
    const toolbar = byId('toolbar').getBoundingClientRect();
    Object.assign(box.style, { left: '0px', top: `${toolbar.bottom}px`, width: '100%' });
  } else {
    const rect = form.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.bottom + 4}px`,
      width: `${rect.width}px`,
    });
  }
  box.hidden = false;
}

/** Opens url in the active tab, or after the start when the engine is not running yet. */
function go(url: string): void {
  hideSuggestions();
  if (!url) return;
  const tab = activeTab();
  if (!tab) {
    pending = url;
    showStartNote(`${url} opens as soon as the engine runs.`);
    address.blur();
    return;
  }
  address.value = url;
  loadInTab(tab, url);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // A row chosen with the arrow keys, else what the text means
  const row = selected > 0 ? rows[selected] : undefined;
  go(row ? row.url : addressToURL(address.value));
});
// While the user still types, connect to where Enter most likely goes, like Chrome: the first
// suggestion, else the typed address or the search engine (saves the round trips of TCP and TLS
// on a slow link)
function preconnectTyped(): void {
  clearTimeout(preconnectTimer);
  preconnectTimer = setTimeout(() => {
    const url = suggestions(address.value, 1)[0]?.url ?? addressToURL(address.value);
    if (url) runtime.browser?.preconnect(url);
  }, 300);
}

/** Back to the address of the tab and out of the field. */
function revert(): void {
  hideSuggestions();
  address.value = current;
  focusPage();
}

// The first click or tap selects the whole address, so typing replaces it (Chrome, Safari);
// a drag selects as usual, a second click places the caret
address.addEventListener('pointerdown', () => {
  selectOnClick = document.activeElement !== address;
});
address.addEventListener('click', () => {
  if (selectOnClick && address.selectionStart === address.selectionEnd) address.select();
  selectOnClick = false;
});
address.addEventListener('focus', () => {
  // The full address while editing (the phone layout shows only the host)
  if (address.value === shownText(current)) address.value = isBlank(current) ? '' : current;
  address.select();
});
address.addEventListener('input', () => {
  showSuggestions();
  preconnectTyped();
});
address.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 100);
  if (compactLayout() || address.value === current) address.value = shownText(current);
});
address.addEventListener('keydown', (e) => {
  // Tab in the address bar: into the page (first or last element)
  if (e.key === 'Tab') {
    const tab = activeTab();
    if (!tab || tab.newTab) return;
    e.preventDefault();
    tab.view.focusFirstElement(!e.shiftKey);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    revert();
    return;
  }
  if (box.hidden || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  select((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
  address.value = rows[selected]?.text ?? address.value;
});
// The phone layout shows only the host: follow a change of the layout (rotation)
addEventListener('resize', () => showAddress(current));
