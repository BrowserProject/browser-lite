// Einstellungen: die prefs "settings" des Profils (profile.js), was davon beim Start der Engine
// gilt (Geraet, User-Agent, Sprache, Zeitzone, ...) und die Seite Einstellungen ueber dem
// Browser, wie chrome://settings (Menue und Muelleimer der Werkzeugleiste).

import { DEFAULT_DB_LIMIT, localStats, prefs, prefsSaved, profileInfo, profileStatus, resetProfile, savePrefs, siteOfPath } from './profile.js';
import { element, formatSize, formatTime, reloadUI, restartUI, takeRestart } from './util.js';

export const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/html/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
};

export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// Nur User-Agents von WebKit (Safari), Standard ist der der Engine (Linux). Das iPad meldet
// sich wie echtes iPadOS als Mac (MacIntel): so sehen Seiten das Gleiche wie auf einem iPad und
// erkennen es wie dort an navigator.maxTouchPoints. Mit Groesse: Mobilgeraet mit Touch.
const SAFARI = 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0';
const MAC_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI} Safari/605.1.15`;
export const DEVICES = {
  desktop: { name: 'Desktop (Linux)', userAgent: '', platform: '' },
  mac: { name: 'Mac', userAgent: MAC_UA, platform: 'MacIntel' },
  iphone: { name: 'iPhone', userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ${SAFARI} Mobile/15E148 Safari/604.1`,
    platform: 'iPhone', width: 390, height: 844, scale: 3 },
  ipad: { name: 'iPad', userAgent: MAC_UA, platform: 'MacIntel', width: 820, height: 1180, scale: 2 },
};
const DB_LIMITS = [128, 256, 512, 1024, 4096];

const DEFAULTS = {
  searchEngine: 'duckduckgo', restoreSession: true, homePage: '',
  device: 'desktop', userAgent: '', languages: '', timeZone: '', colorScheme: 'system', zoom: 1,
  javascript: true, images: true, gpc: false, dbLimit: DEFAULT_DB_LIMIT,
};

export function settings() {
  return { ...DEFAULTS, ...prefs('settings') };
}

export function saveSettings(changes) {
  savePrefs('settings', { ...prefs('settings'), ...changes });
}

// Ohne Zusatz wie "@posix" (Linux ohne Sprache), den die Engine nicht als Sprache kennt
const hostLanguages = () => (navigator.languages?.length ? navigator.languages : [navigator.language]).map((language) => language.split('@')[0]).join(',');
const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ------------------------------------------------------------ Start der Engine

// Was beim Start gilt (nach openProfile), Aenderungen erst nach einem Neustart
let start = null;
export function startSettings() {
  if (start)
    return start;
  const current = settings();
  const device = DEVICES[current.device] || DEVICES.desktop;
  // "Jetzt neu starten" und der Neustart nach einem Absturz behalten die Sitzung immer
  const restarted = takeRestart();
  const restoreSession = current.restoreSession || restarted;
  start = {
    // Mobilgeraet: Groesse in CSS-Pixeln, Pixeldichte, Touch
    device: device.width ? device : null,
    userAgent: current.userAgent.trim() || device.userAgent,
    platform: device.platform,
    languages: current.languages.trim() || hostLanguages(),
    timeZone: current.timeZone.trim() || hostTimeZone(),
    colorScheme: current.colorScheme,
    zoom: current.zoom,
    preferences: (current.javascript ? 0 : 1) | (current.images ? 0 : 2) | (current.gpc ? 4 : 0),
    restoreSession,
    // Wie Chrome bei "Weitermachen, wo ich aufgehoert habe": Sitzungs-Cookies bleiben
    keepSessionCookies: restoreSession,
  };
  return start;
}

// Umgebung der Engine (preRun)
export function engineEnvironment() {
  const { timeZone, keepSessionCookies } = startSettings();
  return { TZ: timeZone, ...(keepSessionCookies ? { BL_KEEP_SESSION_COOKIES: '1' } : {}) };
}

// Nach onEngineReady, vor dem ersten View
export function applyEngineSettings(engine, toUTF8) {
  const { userAgent, platform, languages, preferences } = startSettings();
  engine._bl_set_user_agent(toUTF8(userAgent), toUTF8(platform));
  engine._bl_set_languages(toUTF8(languages));
  engine._bl_set_preferences(preferences);
}

// ------------------------------------------------------------ Seite

let api; // { clearCaches(), focusPage() }
const SECTIONS = { general: 'Allgemein', profile: 'Profil', device: 'Gerät und Browser' };
// Modal: der Browser dahinter ist inert, Esc schliesst
const page = element('dialog', { id: 'settings' });
page.setAttribute('aria-label', 'Einstellungen');
const nav = element('nav', {}, element('h1', { textContent: 'Einstellungen' }));
for (const [key, title] of Object.entries(SECTIONS)) {
  const button = element('button', { textContent: title });
  button.dataset.section = key;
  button.addEventListener('click', () => showSection(key));
  nav.append(button);
}
const content = element('div', { className: 'settings-content' });
const close = element('button', { className: 'settings-close', textContent: '×' });
close.setAttribute('aria-label', 'Schliessen');
close.addEventListener('click', () => closeSettings());
page.append(nav, content, close);
page.addEventListener('close', () => {
  content.textContent = '';
  api?.focusPage();
});
document.body.appendChild(page);

export function initSettings(options) {
  api = options;
}

export function openSettings(name = 'general') {
  if (!page.open)
    page.showModal();
  showSection(name);
  nav.querySelector(`[data-section=${name}]`).focus();
}

export function closeSettings() {
  page.close();
}

export const settingsOpen = () => page.open;

function showSection(name) {
  for (const button of nav.querySelectorAll('button')) {
    const active = button.dataset.section === name;
    button.classList.toggle('active', active);
    if (active)
      button.setAttribute('aria-current', 'page');
    else
      button.removeAttribute('aria-current');
  }
  // Neu fuer jeden Abschnitt: was spaeter kommt (profileInfo), prueft section.isConnected
  const section = element('section', {}, element('h2', { textContent: SECTIONS[name] }));
  content.replaceChildren(section);
  ({ general: renderGeneral, profile: renderProfile, device: renderDevice })[name](section);
}

function row(label, control, hint = '') {
  return element('label', { className: 'settings-row' }, element('span', {}, label, hint ? element('small', { textContent: hint }) : ''), control);
}

function choice(id, options, value, onChange) {
  const select = element('select', { id });
  for (const [key, name] of options)
    select.append(element('option', { value: key, textContent: name, selected: String(key) === String(value) }));
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function toggle(id, checked, onChange) {
  const input = element('input', { type: 'checkbox', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function text(id, value, placeholder, onChange) {
  const input = element('input', { type: 'text', id, value, placeholder, spellcheck: false });
  input.addEventListener('change', () => onChange(input.value.trim(), input));
  return input;
}

function renderGeneral(section) {
  const current = settings();
  section.append(
    row('Suchmaschine', choice('setting-search', Object.entries(SEARCH_ENGINES).map(([key, engine]) => [key, engine.name]), current.searchEngine,
      (value) => saveSettings({ searchEngine: value }))),
    row('Tabs beim Start wiederherstellen', toggle('setting-restore', current.restoreSession, (value) => saveSettings({ restoreSession: value })),
      'Behält auch die Sitzungs-Cookies der Websites'),
    row('Startseite für neue Tabs', text('setting-home', current.homePage, 'leer = leerer Tab', (value) => saveSettings({ homePage: value }))),
  );
}

// ------------------------------------------------------------ Profil

function renderProfile(section) {
  const status = profileStatus();
  const state = element('p', { id: 'profile-state', className: 'settings-state', textContent: status.text });
  state.dataset.state = status.state;
  const problem = element('p', { className: 'settings-hint', textContent: status.problem, hidden: !status.problem });
  const facts = element('dl', { className: 'settings-facts' });
  const sites = element('div', { className: 'settings-table' }, element('p', { className: 'settings-hint', textContent: 'Wird geladen …' }));
  const local = element('ul', { className: 'settings-local' });
  const message = element('p', { className: 'settings-error', hidden: true });
  const clear = element('button', { id: 'settings-clear-site-data', textContent: 'Websitedaten löschen' });
  const reset = element('button', { id: 'settings-reset-profile', className: 'danger', textContent: 'Profil zurücksetzen' });
  clear.addEventListener('click', () => resetData(false, message));
  reset.addEventListener('click', () => resetData(true, message));
  // Nur der Tab mit dem Profil, und nicht nach der Uebernahme durch ein anderes Geraet
  const usable = status.state === 'connected' || status.state === 'local';
  clear.disabled = reset.disabled = !usable;
  const blocked = status.state === 'off' ? 'Löschen geht nur in dem Tab, der das Profil hat.' : 'Zum Löschen zuerst neu laden.';
  section.append(state, problem, facts, element('h3', { textContent: 'Daten der Websites im Profil' }), sites,
    element('h3', { textContent: 'Nur auf diesem Gerät (nicht im Profil)' }), local,
    element('div', { className: 'settings-actions' }, clear, reset), message,
    element('p', { className: 'settings-hint', textContent: blocked, hidden: usable }),
    element('p', { className: 'settings-hint', textContent: 'Websitedaten löschen: Cookies, Speicher der Websites und Berechtigungen, du wirst überall abgemeldet. Profil zurücksetzen: dazu auch Einstellungen und Lesezeichen.' }));
  profileInfo().then((info) => {
    if (section.isConnected)
      fillProfile(info, facts, sites);
  });
  localStats().then((stats) => {
    if (section.isConnected)
      fillLocal(stats, local);
  }, (error) => console.warn('Profil:', error));
}

function fillProfile(info, facts, sites) {
  const fact = (label, value) => facts.append(element('dt', { textContent: label }), element('dd', { textContent: value }));
  const limit = settings().dbLimit * 1024;
  if (!info) {
    fact('Grenze pro Datenbank', formatSize(limit));
    sites.replaceChildren(element('p', { className: 'settings-hint', textContent: 'Ohne Verbindung zum Profil-Server nicht verfügbar.' }));
    return;
  }
  fact('Profil seit', formatTime(info.created));
  fact('Zuletzt gespeichert', formatTime(info.updated));
  if (info.device)
    fact('Geöffnet auf', `${info.device}, ${formatTime(info.opened)}`);
  fact('Grösse', `${formatSize(info.bytes)} von ${formatSize(info.maxBytes)}`);
  fact('Grenze pro Datenbank', formatSize(limit));

  // Pro Website (Host ohne www.): Cookies der Domain, localStorage, IndexedDBs
  const rows = new Map();
  const site = (host) => {
    const key = host.replace(/^\./, '').replace(/^www\./, '');
    if (!rows.has(key))
      rows.set(key, { cookies: 0, local: 0, databases: new Set(), databaseBytes: 0 });
    return rows.get(key);
  };
  for (const cookie of info.cookies || [])
    site(cookie.domain).cookies += cookie.count;
  for (const file of info.files) {
    if (file.path === 'cookies.db')
      continue;
    const host = URL.parse(siteOfPath(file.path))?.hostname || siteOfPath(file.path);
    const entry = site(host);
    if (file.path.startsWith('localstorage/')) {
      entry.local += file.size;
    } else {
      entry.databases.add(file.path.slice(0, file.path.lastIndexOf('/')));
      entry.databaseBytes += file.size;
    }
  }
  if (!rows.size) {
    sites.replaceChildren(element('p', { className: 'settings-hint', textContent: 'Noch keine Daten von Websites im Profil.' }));
    return;
  }
  const table = element('table', {}, element('thead', {}, element('tr', {}, ...['Website', 'Cookies', 'localStorage', 'IndexedDB'].map((title) => element('th', { textContent: title })))));
  const body = element('tbody');
  for (const [host, entry] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const databases = entry.databases.size ? `${entry.databases.size} (${formatSize(entry.databaseBytes)})` : '';
    body.append(element('tr', {}, element('td', { textContent: host }), element('td', { textContent: info.cookies ? String(entry.cookies || '') : '?' }),
      element('td', { textContent: entry.local ? formatSize(entry.local) : '' }), element('td', { textContent: databases })));
  }
  table.append(body);
  sites.replaceChildren(table);
}

function fillLocal(stats, list) {
  const item = (label, size) => list.append(element('li', {}, element('span', { textContent: label }), element('span', { textContent: formatSize(size) })));
  for (const database of stats.databases)
    item(`${database.site}: ${database.kind} (über der Grenze)`, database.size);
  item('Cache der Websites (Cache API)', stats.cacheStorage);
  if (stats.httpCache != null)
    item('Zwischenspeicher (HTTP-Cache)', stats.httpCache);
  item('Service Worker', stats.serviceWorkers);
  item('Website-Dateien (OPFS)', stats.pageFiles);
  list.append(element('li', {}, element('span', { textContent: 'Verlauf und offene Tabs' }), element('span', { textContent: 'nur hier' })));
}

async function resetData(all, message) {
  const question = all
    ? 'Profil zurücksetzen? Alles wird gelöscht: Cookies, Speicher der Websites, Berechtigungen, Einstellungen und Lesezeichen.'
    : 'Websitedaten löschen? Cookies, Speicher der Websites und Berechtigungen werden gelöscht, du wirst überall abgemeldet. Einstellungen und Lesezeichen bleiben.';
  const local = profileStatus().state === 'local' ? '\n\nDer Profil-Server ist nicht erreichbar: gelöscht wird nur auf diesem Gerät.' : '';
  if (!confirm(question + local))
    return;
  try {
    await resetProfile(all);
  } catch (error) {
    message.textContent = error.message;
    message.hidden = false;
    return;
  }
  await api.clearCaches();
  await prefsSaved();
  reloadUI();
}

// ------------------------------------------------------------ Geraet und Browser

function renderDevice(section) {
  const current = settings();
  const timeZone = text('setting-timezone', current.timeZone, hostTimeZone(), (value, input) => {
    try {
      if (value)
        Intl.DateTimeFormat(undefined, { timeZone: value });
      input.setCustomValidity('');
      saveSettings({ timeZone: value });
    } catch {
      input.setCustomValidity('Unbekannte Zeitzone');
      input.reportValidity();
    }
  });
  timeZone.setAttribute('list', 'setting-timezones');
  const zones = element('datalist', { id: 'setting-timezones' }, ...(Intl.supportedValuesOf?.('timeZone') || []).map((zone) => element('option', { value: zone })));
  const restart = element('button', { id: 'settings-restart', className: 'primary', textContent: 'Jetzt neu starten' });
  restart.addEventListener('click', async () => {
    await prefsSaved();
    restartUI();
  });
  section.append(
    row('Gerät', choice('setting-device', Object.entries(DEVICES).map(([key, device]) => [key, device.name]), current.device, (value) => saveSettings({ device: value }))),
    row('User-Agent', text('setting-user-agent', current.userAgent, 'vom Gerät', (value) => saveSettings({ userAgent: value }))),
    row('Sprachen der Websites', text('setting-languages', current.languages, hostLanguages(), (value) => saveSettings({ languages: value })), 'z.B. de-CH,de,en'),
    row('Zeitzone', timeZone), zones,
    row('Farbschema', choice('setting-color-scheme', [['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], current.colorScheme, (value) => saveSettings({ colorScheme: value }))),
    row('Standard-Zoom', choice('setting-zoom', ZOOM_LEVELS.map((level) => [level, Math.round(level * 100) + ' %']), current.zoom, (value) => saveSettings({ zoom: Number(value) }))),
    row('JavaScript', toggle('setting-javascript', current.javascript, (value) => saveSettings({ javascript: value }))),
    row('Bilder', toggle('setting-images', current.images, (value) => saveSettings({ images: value }))),
    row('Global Privacy Control', toggle('setting-gpc', current.gpc, (value) => saveSettings({ gpc: value })), 'Bittet Websites, deine Daten nicht weiterzugeben'),
    row('Grenze pro Datenbank im Profil', choice('setting-db-limit', DB_LIMITS.map((kb) => [kb, formatSize(kb * 1024)]), current.dbLimit, (value) => saveSettings({ dbLimit: Number(value) })),
      'Grössere Datenbanken bleiben nur auf diesem Gerät'),
    element('p', { className: 'settings-hint', textContent: 'Ein anderes Gerät oder ein anderer User-Agent kann dich auf Websites abmelden. Änderungen gelten nach einem Neustart.' }),
    element('div', { className: 'settings-actions' }, restart),
  );
}
