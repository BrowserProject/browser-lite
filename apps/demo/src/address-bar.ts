import { bookmarks } from './bookmarks.js';
import { showStartNote } from './engine-message.js';
import { favicon, hostOf } from './favicons.js';
import { readHistory } from './history.js';
import { icon } from './icons.js';
import { compactLayout } from './layout.js';
import { runtime } from './runtime.js';
import { SEARCH_ENGINES, settings } from './settings.js';
import { activeTab, focusPage, loadInTab, openTab } from './tabs.js';
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
/** The text the user typed; the field shows more while a site is completed inline. */
let typed = '';
/** The site that completes the typed text inline (the first row), if any. */
let inline: Row | null = null;
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

/**
 * Text of the address bar as URL: an address, or a search with the search engine. Like Chrome an
 * address that is invalid (a port above 65535) is a search.
 */
export function addressToURL(text: string): string {
  const value = text.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value))
    return URL.canParse(value) ? value : searchURL(value);
  if (/^(localhost|[^\s/]+\.[^\s/]+|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(value)) {
    const url = `https://${value}`;
    if (URL.canParse(url)) return url;
  }
  return searchURL(value);
}

/** Bookmarks and visited pages, weighted: a bookmark much, a visit more the more recent it is. */
function weightedPages(): { url: string; title: string; points: number }[] {
  const now = Date.now();
  return [
    ...bookmarks().map(({ url, title }) => ({ url, title, points: 50 })),
    ...readHistory().map(({ url, title, time }) => ({
      url,
      title,
      points: 1 + Math.max(0, 10 - (now - time) / 86400000),
    })),
  ];
}

/** Suggestions like Chrome: bookmarks first, then pages visited often and recently. */
export function suggestions(text: string, limit = 8): { url: string; title: string }[] {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const score = new Map<string, { url: string; title: string; points: number }>();
  const matches = (url: string, title: string) =>
    url
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '')
      .includes(query) || (title || '').toLowerCase().includes(query);
  for (const page of weightedPages()) {
    if (!matches(page.url, page.title)) continue;
    const entry = score.get(page.url) ?? { url: page.url, title: page.title, points: 0 };
    entry.points += page.points;
    if (page.title) entry.title = page.title;
    score.set(page.url, entry);
  }
  return [...score.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

/** How a site can be typed, shortest first: without scheme and www., without scheme, whole. */
function typedForms(origin: string): string[] {
  const host = origin.replace(/^https?:\/\//, '');
  return [host.replace(/^www\./, ''), host, origin];
}

/**
 * Inline completion like Chrome: the bookmarked or visited site whose host starts with text, the
 * one with the most weight. The row shows text completed to the host and opens the site with the
 * scheme it was visited with. Only sites: text with a path completes nothing.
 */
function inlineCompletion(text: string): Row | null {
  const query = text.toLowerCase();
  if (!query || /\s/.test(query) || /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*\//.test(query)) return null;
  const weight = new Map<string, number>();
  for (const page of weightedPages()) {
    if (!/^https?:\/\//i.test(page.url) || !URL.canParse(page.url)) continue;
    const { origin } = new URL(page.url);
    if (typedForms(origin).some((form) => form.startsWith(query)))
      weight.set(origin, (weight.get(origin) ?? 0) + page.points);
  }
  let best = '';
  for (const [origin, points] of weight) if (points > (weight.get(best) ?? 0)) best = origin;
  const form = typedForms(best).find((form) => form.startsWith(query));
  return best && form ? { url: `${best}/`, text: text + form.slice(text.length) } : null;
}

/**
 * Chrome's Ctrl+Enter: a name without a dot becomes a .com site with www. (wikipedia opens
 * www.wikipedia.com), with its port and path. Chrome also completes names with a dot but no known
 * top level domain (mail.yahoo); without the list of those domains only names without a dot.
 */
function withDotCom(text: string): string {
  const match = /^([a-z0-9-]+)(:\d+)?([/?#]\S*)?$/i.exec(text.trim());
  return match ? `www.${match[1]}.com${match[2] ?? ''}${match[3] ?? ''}` : text;
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
  inline = null;
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

/**
 * The rows for the text in the field. With complete (the user typed at the end) a visited site
 * that starts with the text completes it inline, selected so that typing goes on over it.
 */
function showSuggestions(complete: boolean): void {
  typed = address.value;
  const text = typed.trim();
  box.textContent = '';
  if (!text) {
    hideSuggestions();
    return;
  }
  rows = [];
  selected = -1;
  const atEnd = address.selectionStart === typed.length && address.selectionEnd === typed.length;
  inline = complete && atEnd ? inlineCompletion(typed) : null;
  if (inline) {
    rows.push(inline);
    box.append(rowElement(inline, favicon(inline.url), inline.text, inline.url));
    address.value = inline.text;
    address.setSelectionRange(typed.length, inline.text.length, 'backward');
  }
  // Then what Enter does with the text alone: open it as an address, and always a search
  const asAddress = addressToURL(text);
  const search = searchURL(text);
  if (asAddress !== search && asAddress !== inline?.url) {
    const row = { url: asAddress, text };
    rows.push(row);
    box.append(rowElement(row, icon('globe'), asAddress));
  }
  const searchRow = { url: search, text };
  rows.push(searchRow);
  box.append(
    rowElement(searchRow, icon('search'), `Search ${searchEngine()?.name ?? ''} for "${text}"`),
  );
  for (const entry of suggestions(text)) {
    if (entry.url === asAddress || entry.url === inline?.url) continue;
    const row = { url: entry.url, text: entry.url };
    rows.push(row);
    box.append(rowElement(row, favicon(entry.url), entry.title || entry.url, entry.url));
  }
  select(0);
  box.hidden = false;
  placeSuggestions();
}

/**
 * Under the address field; in the phone layout over the whole width above the toolbar at the
 * bottom (and so above the on-screen keyboard), as high as the room up to the top.
 */
function placeSuggestions(): void {
  if (box.hidden) return;
  const chrome = byId('chrome');
  if (compactLayout()) {
    // Inside the toolbar's container, right above it: iOS moves the visual viewport under the
    // keyboard, so coordinates of the window would point behind the keyboard or the bar
    if (box.parentElement !== chrome) chrome.append(box);
    const toolbar = byId('toolbar').getBoundingClientRect();
    const top = window.visualViewport?.offsetTop ?? 0;
    Object.assign(box.style, {
      position: 'absolute',
      left: '0px',
      top: '',
      bottom: '100%',
      width: '100%',
      maxHeight: `${Math.max(120, toolbar.top - top)}px`,
    });
  } else {
    if (box.parentElement === chrome) document.body.append(box);
    box.style.position = '';
    const rect = form.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.bottom + 6}px`,
      bottom: '',
      width: `${rect.width}px`,
      maxHeight: '',
    });
  }
}

/**
 * Opens url in the active tab (with inNewTab in a new tab in front), or after the start when the
 * engine is not running yet.
 */
function go(url: string, inNewTab = false): void {
  hideSuggestions();
  if (!url) return;
  const tab = activeTab();
  if (!tab) {
    pending = url;
    showStartNote(`${url} opens as soon as the engine runs.`);
    address.blur();
    return;
  }
  if (inNewTab) {
    // The tab left behind shows its own address again
    address.value = current;
    openTab(url);
    return;
  }
  address.value = url;
  loadInTab(tab, url);
}

/**
 * Enter: the row chosen with the arrow keys or completed inline while the field shows it, else
 * the text as address. Like Chrome Ctrl+Enter makes the typed name a .com site (without the
 * inline completion) and Alt+Enter opens a new tab in front.
 */
function submit({ ctrlKey = false, altKey = false } = {}): void {
  const row = rows[selected];
  const shown = row && address.value === row.text;
  let url = shown ? row.url : addressToURL(address.value);
  if (ctrlKey) url = addressToURL(withDotCom(shown && row === inline ? typed : address.value));
  go(url, altKey);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
// While the user still types, connect to where Enter most likely goes, like Chrome: the site
// completed inline, else the first suggestion, else the typed address or the search engine
// (saves the round trips of TCP and TLS on a slow link)
function preconnectTyped(): void {
  clearTimeout(preconnectTimer);
  preconnectTimer = setTimeout(() => {
    const url = inline?.url ?? suggestions(typed, 1)[0]?.url ?? addressToURL(typed);
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
address.addEventListener('input', (e) => {
  // Only while editing: text set from outside (autofill, test drivers) opens no suggestions
  if (document.activeElement !== address) return;
  // Only typing completes: after a deletion the completion stays away, like in Chrome
  showSuggestions((e as InputEvent).inputType === 'insertText');
  preconnectTyped();
});
address.addEventListener('blur', () => {
  // Unless the user is back in the field and typing again (rows of the new text)
  setTimeout(() => {
    if (document.activeElement !== address) hideSuggestions();
  }, 100);
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
  // Browsers submit the form only on Enter without Ctrl and Alt
  if (e.key === 'Enter' && (e.ctrlKey || e.altKey) && !e.isComposing) {
    e.preventDefault();
    submit(e);
    return;
  }
  if (box.hidden || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  select((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
  address.value = rows[selected]?.text ?? address.value;
});
// The phone layout shows only the host: follow a change of the layout (rotation); the
// suggestions follow the toolbar when the on-screen keyboard comes or goes (after
// visual-viewport.ts fitted the page)
addEventListener('resize', () => {
  showAddress(current);
  requestAnimationFrame(placeSuggestions);
});
window.visualViewport?.addEventListener('resize', () => requestAnimationFrame(placeSuggestions));
// Editing ends like in Chrome on Android when the on-screen keyboard goes away (its back button
// closes it without a blur) or a tap lands outside the address and its suggestions
let keyboardHeight = 0;
window.visualViewport?.addEventListener('resize', () => {
  const visual = window.visualViewport;
  if (!visual) return;
  const covered =
    Math.max(window.innerHeight, document.documentElement.clientHeight) - visual.height;
  if (compactLayout() && document.activeElement === address && keyboardHeight > 120 && covered < 60)
    address.blur();
  keyboardHeight = covered;
});
addEventListener('resize', () => {
  const grew = window.innerHeight - lastInnerHeight;
  lastInnerHeight = window.innerHeight;
  if (compactLayout() && document.activeElement === address && grew > 120) address.blur();
});
let lastInnerHeight = window.innerHeight;
document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target as Node;
    if (form.contains(target) || box.contains(target)) return;
    if (document.activeElement === address) address.blur();
    else if (!box.hidden) hideSuggestions();
  },
  { capture: true },
);
