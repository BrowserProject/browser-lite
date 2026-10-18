import { bookmarks } from './bookmarks.js';
import { readHistory } from './history.js';
import { SEARCH_ENGINES, settings } from './settings.js';
import { activeTab, focusPage } from './tabs.js';
import { byId, element } from './util.js';

const form = byId<HTMLFormElement>('address-form');
const address = byId<HTMLInputElement>('address');
const box = byId('suggestions');
let selected = -1;

/** Text of the address bar as URL: an address, or a search with the search engine. */
export function addressToURL(text: string): string {
  const value = text.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value)) return value;
  if (/^(localhost|[^\s/]+\.[^\s/]+|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(value))
    return `https://${value}`;
  const engine = SEARCH_ENGINES[settings().searchEngine] ?? SEARCH_ENGINES.duckduckgo;
  return (engine?.url ?? '').replace('%s', encodeURIComponent(value));
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

/** Moves the keyboard to the address bar and selects it (Ctrl+L, F6). */
export function focusAddress(): void {
  address.focus();
  address.select();
}

function hideSuggestions(): void {
  box.hidden = true;
  selected = -1;
}

function showSuggestions(): void {
  const list = suggestions(address.value);
  box.textContent = '';
  selected = -1;
  if (!list.length) {
    hideSuggestions();
    return;
  }
  for (const entry of list) {
    const row = element(
      'div',
      { className: 'suggestion' },
      element('span', { className: 'suggestion-title', textContent: entry.title || entry.url }),
      element('span', { className: 'suggestion-url', textContent: entry.url }),
    );
    row.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      address.value = entry.url;
      hideSuggestions();
      form.requestSubmit();
    });
    box.append(row);
  }
  const rect = address.getBoundingClientRect();
  Object.assign(box.style, {
    left: `${rect.left}px`,
    top: `${rect.bottom + 2}px`,
    width: `${rect.width}px`,
  });
  box.hidden = false;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const tab = activeTab();
  if (!tab) return;
  hideSuggestions();
  const url = addressToURL(address.value);
  if (!url) return;
  tab.view.load(url);
  focusPage();
});
address.addEventListener('input', showSuggestions);
address.addEventListener('blur', () => setTimeout(hideSuggestions, 100));
address.addEventListener('keydown', (e) => {
  // Tab in the address bar: into the page (first or last element)
  if (e.key === 'Tab') {
    const tab = activeTab();
    if (!tab) return;
    e.preventDefault();
    tab.view.focusFirstElement(!e.shiftKey);
    return;
  }
  if (box.hidden || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    hideSuggestions();
    return;
  }
  const rows = [...box.children];
  rows[selected]?.classList.remove('selected');
  selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  const row = rows[selected];
  row?.classList.add('selected');
  address.value = row?.querySelector('.suggestion-url')?.textContent ?? address.value;
});
