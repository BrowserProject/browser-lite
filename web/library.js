// Was ein Browser sich merkt: Sitzung (offene Tabs), Verlauf und Downloads nur auf
// diesem Geraet (localStorage des Host), Lesezeichen im Profil (profile.js). Dazu ein
// Seitenpanel (Menue, Strg+H, Strg+J, Strg+Umschalt+O) und Vorschlaege in der Adressleiste
// wie in Chrome.

import { prefs, savePrefs } from './profile.js';
import { SEARCH_ENGINES, settings, startSettings } from './settings.js';
import { element, formatSize, formatTime } from './util.js';

const KEYS = { session: 'bl-session', history: 'bl-history' };
const MAX_HISTORY = 3000;

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Voll: beim Verlauf die aeltere Haelfte wegwerfen und nochmals versuchen
    if (key === KEYS.history && Array.isArray(value) && value.length > 10) {
      try {
        localStorage.setItem(key, JSON.stringify(value.slice(-Math.floor(value.length / 2))));
      } catch (e2) {}
    }
  }
}

const isInternal = (url) => !url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:');

let api; // { openURL(url, newTab), activeTab(), tabs(), downloadsList(), find(), print(), openSettings() }

export function initLibrary(options) {
  api = options;
  buildToolbar();
}

// Text aus der Adressleiste -> URL (Adresse oder Suche)
export function addressToURL(text) {
  const value = text.trim();
  if (!value)
    return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value))
    return value;
  if (/^(localhost|[^\s/]+\.[^\s/]+|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(value))
    return 'https://' + value;
  const engine = SEARCH_ENGINES[settings().searchEngine] || SEARCH_ENGINES.duckduckgo;
  return engine.url.replace('%s', encodeURIComponent(value));
}

// ------------------------------------------------------------ Sitzung

// Pro Tab auch Zurueck/Vor (hoechstens 25 Eintraege um den aktuellen herum)
function sessionHistory(tab) {
  const history = tab.pendingHistory || tab.history;
  if (!history?.entries?.length)
    return undefined;
  const start = Math.max(0, history.index - 20);
  const entries = history.entries.slice(start, start + 25).map((entry) => ({ url: entry.url, title: entry.title }));
  const index = Math.min(history.index - start, entries.length - 1);
  // Der Titel kommt oft erst nach der Navigation
  if (entries[index] && entries[index].url === tab.url && tab.title)
    entries[index].title = tab.title;
  return { entries, index };
}

export function saveSession(tabs, active) {
  const list = tabs.filter((t) => !isInternal(t.url)).map((t) => ({ url: t.url, title: t.title, active: t === active, history: sessionHistory(t) }));
  write(KEYS.session, { tabs: list, time: Date.now() });
}

export function sessionToRestore() {
  if (!startSettings().restoreSession)
    return null;
  const session = read(KEYS.session, null);
  return session && session.tabs && session.tabs.length ? session.tabs : null;
}

// ------------------------------------------------------------ Verlauf

export function recordVisit(url, title) {
  if (isInternal(url))
    return;
  // Titel kommt oft erst nach der Adresse: den letzten Eintrag ergaenzen
  const history = read(KEYS.history, []);
  const last = history[history.length - 1];
  if (last && last.url === url && Date.now() - last.time < 30 * 60 * 1000) {
    if (title)
      last.title = title;
  } else {
    history.push({ url, title: title || '', time: Date.now() });
  }
  write(KEYS.history, history.slice(-MAX_HISTORY));
  if (panelName === 'history')
    renderPanel();
}

function clearHistory() {
  write(KEYS.history, []);
}

// ------------------------------------------------------------ Lesezeichen

function bookmarks() {
  return prefs('bookmarks') || [];
}

export function isBookmarked(url) {
  return bookmarks().some((b) => b.url === url);
}

export function toggleBookmark(url, title) {
  if (isInternal(url))
    return false;
  const list = bookmarks();
  const index = list.findIndex((b) => b.url === url);
  if (index >= 0)
    list.splice(index, 1);
  else
    list.push({ url, title: title || url, time: Date.now() });
  savePrefs('bookmarks', list);
  updateStar(url);
  if (panelName === 'bookmarks')
    renderPanel();
  return index < 0;
}

// ------------------------------------------------------------ Vorschlaege

// Lesezeichen zuerst, dann haeufig besuchte Seiten aus dem Verlauf
export function suggestions(text, limit = 8) {
  const query = text.trim().toLowerCase();
  if (!query)
    return [];
  const score = new Map();
  const add = (url, title, points) => {
    const entry = score.get(url) || { url, title, points: 0 };
    entry.points += points;
    if (title)
      entry.title = title;
    score.set(url, entry);
  };
  const matches = (url, title) => url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').includes(query) || (title || '').toLowerCase().includes(query);
  for (const b of bookmarks()) {
    if (matches(b.url, b.title))
      add(b.url, b.title, 50);
  }
  const now = Date.now();
  for (const h of read(KEYS.history, [])) {
    if (matches(h.url, h.title))
      add(h.url, h.title, 1 + Math.max(0, 10 - (now - h.time) / 86400000));
  }
  return [...score.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

// ------------------------------------------------------------ Werkzeugleiste

function buildToolbar() {
  const status = document.getElementById('status');
  const star = document.createElement('button');
  star.id = 'bookmark';
  star.title = 'Lesezeichen (Strg+D)';
  star.textContent = '☆';
  star.addEventListener('click', () => {
    const tab = api.activeTab();
    if (tab)
      toggleBookmark(tab.url, tab.title);
  });
  const menu = document.createElement('button');
  menu.id = 'menu-button';
  menu.title = 'Menü';
  menu.textContent = '⋮';
  menu.addEventListener('click', () => togglePanel(panelName ? null : 'menu'));
  status.after(star);
  document.getElementById('clear-data').after(menu);
}

export function updateStar(url) {
  const star = document.getElementById('bookmark');
  if (!star)
    return;
  const marked = isBookmarked(url);
  star.textContent = marked ? '★' : '☆';
  star.classList.toggle('active', marked);
  star.disabled = isInternal(url);
}

// ------------------------------------------------------------ Seitenpanel

const panel = document.createElement('aside');
panel.id = 'side-panel';
panel.hidden = true;
document.body.appendChild(panel);
let panelName = null;
let panelFilter = '';

export function togglePanel(name) {
  if (!name || name === panelName) {
    panelName = null;
    panel.hidden = true;
    return;
  }
  panelName = name;
  panelFilter = '';
  panel.hidden = false;
  renderPanel();
}

export function refreshDownloadsPanel() {
  if (panelName === 'downloads')
    renderPanel();
}

function linkRow(entry, extra) {
  const row = element('div', { className: 'panel-row', title: entry.url });
  const open = element('button', { className: 'panel-link' }, element('span', { className: 'panel-title', textContent: entry.title || entry.url }), element('span', { className: 'panel-url', textContent: entry.url }));
  open.addEventListener('click', (e) => api.openURL(entry.url, e.ctrlKey || e.metaKey || e.button === 1));
  row.append(open);
  if (extra)
    row.append(extra);
  return row;
}

function renderPanel() {
  panel.textContent = '';
  const close = element('button', { className: 'panel-close', title: 'Schliessen', textContent: '×' });
  close.addEventListener('click', () => togglePanel(null));
  const titles = { menu: 'Menü', history: 'Verlauf', bookmarks: 'Lesezeichen', downloads: 'Downloads' };
  panel.append(element('header', {}, element('h2', { textContent: titles[panelName] }), close));

  if (panelName === 'menu') {
    const items = [['Neuer Tab', 'Strg+T', () => api.openURL('', true)], ['Verlauf', 'Strg+H', () => togglePanel('history')],
      ['Lesezeichen', 'Strg+Umschalt+O', () => togglePanel('bookmarks')], ['Downloads', 'Strg+J', () => togglePanel('downloads')],
      ['Suchen auf der Seite', 'Strg+F', () => { togglePanel(null); api.find(); }], ['Drucken …', 'Strg+P', () => { togglePanel(null); api.print(); }],
      ['Einstellungen', '', () => { togglePanel(null); api.openSettings(); }]];
    for (const [label, key, action] of items) {
      const button = element('button', { className: 'panel-menu-item' }, element('span', { textContent: label }), element('kbd', { textContent: key }));
      button.addEventListener('click', action);
      panel.append(button);
    }
    return;
  }

  if (panelName === 'history' || panelName === 'bookmarks') {
    const search = element('input', { type: 'search', className: 'panel-search', placeholder: 'Suchen', value: panelFilter });
    search.addEventListener('input', () => {
      panelFilter = search.value;
      renderList();
    });
    const list = element('div', { className: 'panel-list' });
    panel.append(search, list);
    if (panelName === 'history') {
      const clear = element('button', { className: 'panel-action', textContent: 'Verlauf löschen' });
      clear.addEventListener('click', () => {
        if (confirm('Ganzen Verlauf löschen?')) {
          clearHistory();
          renderList();
        }
      });
      panel.append(clear);
    }
    const renderList = () => {
      list.textContent = '';
      const query = panelFilter.trim().toLowerCase();
      const entries = panelName === 'history' ? read(KEYS.history, []).slice().reverse() : bookmarks().slice().reverse();
      let shown = 0;
      for (const entry of entries) {
        if (query && !(entry.url.toLowerCase().includes(query) || (entry.title || '').toLowerCase().includes(query)))
          continue;
        if (++shown > 300)
          break;
        let extra;
        if (panelName === 'bookmarks') {
          extra = element('button', { className: 'panel-remove', title: 'Entfernen', textContent: '×' });
          extra.addEventListener('click', () => {
            toggleBookmark(entry.url);
            renderList();
          });
        } else {
          extra = element('span', { className: 'panel-time', textContent: formatTime(entry.time) });
        }
        list.append(linkRow(entry, extra));
      }
      if (!shown)
        list.append(element('p', { className: 'panel-empty', textContent: panelName === 'history' ? 'Noch kein Verlauf.' : 'Noch keine Lesezeichen (Stern in der Adressleiste).' }));
    };
    renderList();
    search.focus();
    return;
  }

  if (panelName === 'downloads') {
    const list = element('div', { className: 'panel-list' });
    const downloads = api.downloadsList();
    for (const d of downloads.slice().reverse()) {
      const state = d.error ? 'Fehler: ' + d.error : d.done ? formatSize(d.size) : `${formatSize(d.received)} von ${d.size ? formatSize(d.size) : '?'}`;
      const row = element('div', { className: 'panel-row' }, element('span', { className: 'panel-title', textContent: d.filename }), element('span', { className: 'panel-time', textContent: state }));
      if (d.done && d.url) {
        const save = element('button', { className: 'panel-action', textContent: 'Nochmals speichern' });
        save.addEventListener('click', () => {
          const link = element('a', { href: d.url, download: d.filename });
          document.body.append(link);
          link.click();
          link.remove();
        });
        row.append(save);
      }
      list.append(row);
    }
    if (!downloads.length)
      list.append(element('p', { className: 'panel-empty', textContent: 'Noch keine Downloads.' }));
    panel.append(list);
  }
}

export function panelIsOpen() {
  return !!panelName;
}
