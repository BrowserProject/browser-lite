import { typedAddress } from '@browser-lite/core';
import { bookmarks } from './bookmarks.js';
import { acceptText, droppedText } from './dropped-text.js';
import { showStartNote } from './engine-message.js';
import { favicon, hostOf } from './favicons.js';
import { closeFindOverToolbar } from './find-bar.js';
import { readHistory } from './history.js';
import { icon } from './icons.js';
import { compactLayout } from './layout.js';
import { runtime } from './runtime.js';
import { SEARCH_ENGINES, settings } from './settings.js';
import { activeTab, focusPage, loadInTab, openTab, type Tab } from './tabs.js';
import { hasKnownTld, typedKind } from './typed-kind.js';
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
/** The field shows text of the user (typed, a row chosen) instead of current. */
let edited = false;
/**
 * What the address bar of a tab in the background keeps, like Chrome: the edit (null without
 * one), whether the field had the keyboard and the selection in it.
 */
interface KeptEdit {
  text: string | null;
  focused: boolean;
  selection: [number, number];
}
const keptEdits = new WeakMap<Tab, KeptEdit>();
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
 * The search of text that starts with `?`, like Chrome and Firefox: always a search for the rest
 * (`? example.com` searches for example.com). Null for other text.
 */
function forcedQuery(text: string): string | null {
  const value = text.trim();
  return value.startsWith('?') ? value.slice(1).trim() : null;
}

/**
 * What Enter opens for the text of the address bar: an address, or a search with the search
 * engine. An address without a scheme stays without one: `View.load` gives it https:// with a
 * fallback to http:// like Chrome, or http:// for a local one (`typedAddress` names where it
 * starts). Like Chrome text is an address only when it looks like one (`typedKind`: node.js and
 * an invalid address like a port above 65535 are searches); text that starts with `?` is always a
 * search.
 */
export function addressToLoad(text: string): string {
  const value = text.trim();
  const query = forcedQuery(value);
  if (query !== null) return query && searchURL(query);
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value))
    return URL.canParse(value) ? value : searchURL(value);
  return typedKind(value) === 'address' ? value : searchURL(value);
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
 * Chrome's Ctrl+Enter: a host without a known top level domain becomes a .com site with www.
 * (wikipedia opens www.wikipedia.com, en.wii www.en.wii.com), with its port and path;
 * localhost, IP addresses and names that end in a dot stay.
 */
function withDotCom(text: string): string {
  const match = /^([a-z0-9.-]+)(:\d+)?([/?#]\S*)?$/i.exec(text.trim());
  const host = match?.[1] ?? '';
  const local = /^localhost$|^[\d.]+$|\.$/i.test(host);
  if (!match || local || hasKnownTld(host.toLowerCase())) return text;
  return `${/^www\./i.test(host) ? '' : 'www.'}${host}.com${match[2] ?? ''}${match[3] ?? ''}`;
}

/** What the field shows for url when not focused: on a phone only the host, like mobile browsers. */
function shownText(url: string): string {
  if (isBlank(url)) return '';
  if (!compactLayout()) return url;
  return hostOf(url).replace(/^www\./, '') || url;
}

/**
 * The address of the active tab changed; the field follows unless it is being edited. Like Chrome
 * an edit outside the field ends when the tab goes to another address. The default value follows
 * too: WebKit resets a field with autocomplete=off to it when the demo comes back from the page
 * cache (Safari's Back and Forward), which would otherwise empty it.
 */
export function showAddress(url: string): void {
  const focused = document.activeElement === address;
  if (url !== current && !focused) edited = false;
  current = url;
  address.defaultValue = shownText(url);
  if (!focused && !edited) address.value = shownText(url);
}

/**
 * Another tab becomes active: tab keeps the edit of the address bar and whether the field had the
 * keyboard, like Chrome (the phone layout ends an edit when the field loses the keyboard).
 */
export function leaveAddress(tab: Tab): void {
  const focused = document.activeElement === address;
  hideSuggestions();
  keptEdits.delete(tab);
  if (!compactLayout() && (edited || focused))
    keptEdits.set(tab, {
      text: edited ? address.value : null,
      focused,
      selection: [address.selectionStart ?? 0, address.selectionEnd ?? 0],
    });
  edited = false;
  if (focused) address.blur();
}

/**
 * The active tab became tab (after showAddress showed its address): its kept edit comes back.
 * True when the field took the keyboard again.
 */
export function enterAddress(tab: Tab): boolean {
  const kept = keptEdits.get(tab);
  keptEdits.delete(tab);
  if (!kept) return false;
  if (kept.text !== null) {
    edited = true;
    typed = kept.text;
    address.value = kept.text;
  }
  if (!kept.focused) return false;
  address.focus();
  if (edited) address.setSelectionRange(...kept.selection);
  return true;
}

/** Moves the keyboard to the address bar and selects it (Ctrl+L, F6, Tab past the page). */
export function focusAddress(): void {
  closeFindOverToolbar();
  address.focus();
  address.select();
}

/**
 * Chrome's Ctrl+K and Ctrl+E: the address bar takes the keyboard with `?` in it, so what follows
 * is a search even when it looks like an address. A search already started there is selected
 * after its `?`.
 */
export function focusSearch(): void {
  closeFindOverToolbar();
  const searching = edited && forcedQuery(address.value) !== null;
  address.focus();
  if (searching) {
    address.setSelectionRange(address.value.indexOf('?') + 1, address.value.length);
    return;
  }
  hideSuggestions();
  edited = true;
  typed = address.value = '?';
  address.setSelectionRange(1, 1);
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
  const query = forcedQuery(text);
  box.textContent = '';
  if (!text || query === '') {
    hideSuggestions();
    return;
  }
  rows = [];
  selected = -1;
  // Text after `?` is only a search: no address, no completion, no pages
  if (query !== null) {
    inline = null;
    addSearchRow(query, text);
    openSuggestions();
    return;
  }
  const atEnd = address.selectionStart === typed.length && address.selectionEnd === typed.length;
  inline = complete && atEnd ? inlineCompletion(typed) : null;
  if (inline) {
    rows.push(inline);
    box.append(rowElement(inline, favicon(inline.url), inline.text, inline.url));
    address.value = inline.text;
    address.setSelectionRange(typed.length, inline.text.length, 'backward');
  }
  // Then what Enter does with the text alone: open it as an address, and always a search; like
  // Chrome a host without a known top level domain (node.js) is searched, the address after it
  const search = searchURL(text);
  const opened = addressToLoad(text);
  const offered = opened === search && typedKind(text) === 'maybe' ? text : '';
  const asAddress = opened === search ? offered : opened;
  const shownAddress = typedAddress(asAddress) || asAddress;
  const addressRow = () => {
    if (!asAddress || shownAddress === typedAddress(inline?.url ?? '')) return;
    const row = { url: asAddress, text };
    rows.push(row);
    box.append(rowElement(row, icon('globe'), shownAddress));
  };
  if (!offered) addressRow();
  addSearchRow(text, text);
  if (offered) addressRow();
  for (const entry of suggestions(text)) {
    if (entry.url === shownAddress || entry.url === inline?.url) continue;
    const row = { url: entry.url, text: entry.url };
    rows.push(row);
    box.append(rowElement(row, favicon(entry.url), entry.title || entry.url, entry.url));
  }
  openSuggestions();
}

/** The row that searches for query, showing text in the field while it is selected. */
function addSearchRow(query: string, text: string): void {
  const row = { url: searchURL(query), text };
  rows.push(row);
  box.append(
    rowElement(row, icon('search'), `Search ${searchEngine()?.name ?? ''} for "${query}"`),
  );
}

function openSuggestions(): void {
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
  // The edit ends: the field shows the address of the tab again, the one that loads (pending
  // until its page commits) or, for a javascript: address, the page's
  edited = false;
  address.blur();
  if (inNewTab) openTab(url);
  else loadInTab(tab, url);
}

/**
 * Enter: the row chosen with the arrow keys or completed inline while the field shows it, else
 * the text as address. Like Chrome Ctrl+Enter makes the typed name a .com site (without the
 * inline completion) and Alt+Enter opens a new tab in front.
 */
function submit({ ctrlKey = false, altKey = false } = {}): void {
  const row = rows[selected];
  const shown = row && address.value === row.text;
  let url = shown ? row.url : addressToLoad(address.value);
  if (ctrlKey) url = addressToLoad(withDotCom(shown && row === inline ? typed : address.value));
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
    const url = inline?.url ?? suggestions(typed, 1)[0]?.url ?? typedAddress(addressToLoad(typed));
    if (url) runtime.browser?.preconnect(url);
  }, 300);
}

/** Back to the address of the tab and out of the field. */
function revert(): void {
  hideSuggestions();
  edited = false;
  address.value = current;
  focusPage();
}

/**
 * Escape: like Chrome first back from a row chosen with the arrow keys to the typed text (the
 * suggestions close), else back to the address of the tab.
 */
function onEscape(): void {
  if (box.hidden || selected <= 0) {
    revert();
    return;
  }
  hideSuggestions();
  address.value = typed;
  address.setSelectionRange(typed.length, typed.length);
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
  if (!edited) address.value = isBlank(current) ? '' : current;
  address.select();
});
address.addEventListener('input', (e) => {
  // Only while editing: text set from outside (autofill, test drivers) opens no suggestions
  if (document.activeElement !== address) return;
  edited = true;
  // Only typing completes: after a deletion the completion stays away, like in Chrome
  showSuggestions((e as InputEvent).inputType === 'insertText');
  preconnectTyped();
});
address.addEventListener('blur', () => {
  // Unless the user is back in the field and typing again (rows of the new text)
  setTimeout(() => {
    if (document.activeElement !== address) hideSuggestions();
  }, 100);
  // Like Chrome the edit stays outside the field, unless it is empty (a `?` alone too) or the
  // address again
  const empty = !address.value.trim() || forcedQuery(address.value) === '';
  if (compactLayout() || empty || address.value === current) edited = false;
  if (!edited) address.value = shownText(current);
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
    onEscape();
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
// A link or text dropped on the field opens like Enter (from a page or another window, like
// Firefox and Chrome); text dragged inside the field itself moves as usual
let draggingOwnText = false;
address.addEventListener('dragstart', () => {
  draggingOwnText = true;
});
address.addEventListener('dragend', () => {
  draggingOwnText = false;
});
address.addEventListener('dragover', (e) => {
  if (!draggingOwnText) acceptText(e);
});
address.addEventListener('drop', (e) => {
  if (draggingOwnText) return;
  e.preventDefault();
  go(addressToLoad(droppedText(e.dataTransfer)));
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
