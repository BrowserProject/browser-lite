import { type LocalStats, type ProfileInfo, siteOfPath } from '@browser-lite/profile';
import { renderExtensionSettings } from './extensions.js';
import { reloadUI, restartUI } from './reload.js';
import { profile, runtime } from './runtime.js';
import {
  DB_LIMITS,
  DEVICES,
  hostLanguages,
  hostTimeZone,
  SEARCH_ENGINES,
  type Settings,
  saveSettings,
  settings,
  ZOOM_LEVELS,
} from './settings.js';
import { focusPage } from './tabs.js';
import { element, formatSize, formatTime } from './util.js';

type Section = 'general' | 'profile' | 'device' | 'extensions';

const SECTIONS: Record<Section, string> = {
  general: 'General',
  profile: 'Profile',
  device: 'Device and browser',
  extensions: 'Extensions',
};
/** Runs when the shown section goes away (sections of extensions). */
let leaveSection: (() => void) | null = null;

// Modal like chrome://settings: the browser behind it is inert, Esc closes
const page = element('dialog', { id: 'settings' });
page.setAttribute('aria-label', 'Settings');
const nav = element('nav', {}, element('h1', { textContent: 'Settings' }));
for (const [key, title] of Object.entries(SECTIONS) as [Section, string][]) {
  const button = element('button', { textContent: title });
  button.dataset.section = key;
  button.addEventListener('click', () => showSection(key));
  nav.append(button);
}
const content = element('div', { className: 'settings-content' });
const close = element('button', { className: 'settings-close', textContent: '×' });
close.setAttribute('aria-label', 'Close');
close.addEventListener('click', () => page.close());
page.append(nav, content, close);
page.addEventListener('close', () => {
  leaveSection?.();
  leaveSection = null;
  content.textContent = '';
  focusPage();
});
document.body.append(page);

export function openSettings(name: Section = 'general'): void {
  if (!page.open) page.showModal();
  showSection(name);
  nav.querySelector<HTMLElement>(`[data-section=${name}]`)?.focus();
}

export const settingsOpen = (): boolean => page.open;

function showSection(name: Section): void {
  for (const button of nav.querySelectorAll('button')) {
    const active = button.dataset.section === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  // New for every section: what comes later (profile info) checks section.isConnected
  const section = element('section', {}, element('h2', { textContent: SECTIONS[name] }));
  leaveSection?.();
  leaveSection = null;
  content.replaceChildren(section);
  if (name === 'general') renderGeneral(section);
  else if (name === 'profile') renderProfile(section);
  else if (name === 'device') renderDevice(section);
  else leaveSection = renderExtensionSettings(section);
}

function row(label: string, control: HTMLElement, hint = ''): HTMLElement {
  return element(
    'label',
    { className: 'settings-row' },
    element('span', {}, label, hint ? element('small', { textContent: hint }) : ''),
    control,
  );
}

function choice(
  id: string,
  options: [string | number, string][],
  value: string | number,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = element('select', { id });
  for (const [key, name] of options)
    select.append(
      element('option', {
        value: String(key),
        textContent: name,
        selected: String(key) === String(value),
      }),
    );
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function toggle(id: string, checked: boolean, onChange: (value: boolean) => void) {
  const input = element('input', { type: 'checkbox', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function text(
  id: string,
  value: string,
  placeholder: string,
  onChange: (value: string, input: HTMLInputElement) => void,
): HTMLInputElement {
  const input = element('input', { type: 'text', id, value, placeholder, spellcheck: false });
  input.addEventListener('change', () => onChange(input.value.trim(), input));
  return input;
}

const save =
  <K extends keyof Settings>(key: K, convert: (value: string) => Settings[K]) =>
  (value: string) =>
    saveSettings({ [key]: convert(value) } as Partial<Settings>);

function renderGeneral(section: HTMLElement): void {
  const current = settings();
  section.append(
    row(
      'Search engine',
      choice(
        'setting-search',
        Object.entries(SEARCH_ENGINES).map(([key, engine]) => [key, engine.name]),
        current.searchEngine,
        save('searchEngine', String),
      ),
    ),
    row(
      'Restore tabs at start',
      toggle('setting-restore', current.restoreSession, (value) =>
        saveSettings({ restoreSession: value }),
      ),
      'Also keeps the session cookies of websites',
    ),
    row(
      'Home page for new tabs',
      text('setting-home', current.homePage, 'empty = blank tab', (value) =>
        saveSettings({ homePage: value }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ profile

function renderProfile(section: HTMLElement): void {
  const state = element('p', {
    id: 'profile-state',
    className: 'settings-state',
    textContent: profile.statusText,
  });
  state.dataset.state = profile.status;
  const problem = element('p', {
    className: 'settings-hint',
    textContent: profile.problem,
    hidden: !profile.problem,
  });
  const facts = element('dl', { className: 'settings-facts' });
  const sites = element(
    'div',
    { className: 'settings-table' },
    element('p', { className: 'settings-hint', textContent: 'Loading…' }),
  );
  const local = element('ul', { className: 'settings-local' });
  const message = element('p', { className: 'settings-error', hidden: true });
  const clear = element('button', {
    id: 'settings-clear-site-data',
    textContent: 'Delete site data',
  });
  const reset = element('button', {
    id: 'settings-reset-profile',
    className: 'danger',
    textContent: 'Reset profile',
  });
  clear.addEventListener('click', () => resetData(false, message));
  reset.addEventListener('click', () => resetData(true, message));
  // Only the tab with the profile, and not after another device took it over
  const usable = profile.status === 'connected' || profile.status === 'local';
  clear.disabled = reset.disabled = !usable;
  const blocked =
    profile.status === 'off'
      ? 'Deleting works only in the tab that has the profile.'
      : 'Reload first to delete.';
  section.append(
    state,
    problem,
    facts,
    element('h3', { textContent: 'Data of websites in the profile' }),
    sites,
    element('h3', { textContent: 'Only on this device (not in the profile)' }),
    local,
    element('div', { className: 'settings-actions' }, clear, reset),
    message,
    element('p', { className: 'settings-hint', textContent: blocked, hidden: usable }),
    element('p', {
      className: 'settings-hint',
      textContent:
        'Delete site data: cookies, storage of websites and permissions; you are signed out everywhere. Reset profile: also settings and bookmarks.',
    }),
  );
  void profile.info().then((info) => {
    if (section.isConnected) fillProfile(info, facts, sites);
  });
  profile.localStats().then(
    (stats) => {
      if (section.isConnected) fillLocal(stats, local);
    },
    (error: unknown) => console.warn('profile:', error),
  );
}

function fillProfile(info: ProfileInfo | null, facts: HTMLElement, sites: HTMLElement): void {
  const fact = (label: string, value: string) =>
    facts.append(element('dt', { textContent: label }), element('dd', { textContent: value }));
  const limit = settings().dbLimit * 1024;
  if (!info) {
    fact('Limit per database', formatSize(limit));
    sites.replaceChildren(
      element('p', {
        className: 'settings-hint',
        textContent: 'Not available without a connection to the profile server.',
      }),
    );
    return;
  }
  fact('Profile since', formatTime(info.created));
  fact('Last saved', formatTime(info.updated));
  if (info.device) fact('Opened on', `${info.device}, ${formatTime(info.opened ?? 0)}`);
  fact('Size', `${formatSize(info.bytes)} of ${formatSize(info.maxBytes)}`);
  fact('Limit per database', formatSize(limit));

  // Per website (host without www.): cookies of the domain, localStorage, IndexedDBs
  const rows = new Map<
    string,
    { cookies: number; local: number; databases: Set<string>; databaseBytes: number }
  >();
  const site = (host: string) => {
    const key = host.replace(/^\./, '').replace(/^www\./, '');
    let entry = rows.get(key);
    if (!entry) {
      entry = { cookies: 0, local: 0, databases: new Set(), databaseBytes: 0 };
      rows.set(key, entry);
    }
    return entry;
  };
  for (const cookie of info.cookies ?? []) site(cookie.domain).cookies += cookie.count;
  for (const file of info.files) {
    if (file.path === 'cookies.db') continue;
    const origin = siteOfPath(file.path);
    const entry = site(URL.parse(origin)?.hostname || origin);
    if (file.path.startsWith('localstorage/')) {
      entry.local += file.size;
    } else {
      entry.databases.add(file.path.slice(0, file.path.lastIndexOf('/')));
      entry.databaseBytes += file.size;
    }
  }
  if (!rows.size) {
    sites.replaceChildren(
      element('p', {
        className: 'settings-hint',
        textContent: 'No data of websites in the profile yet.',
      }),
    );
    return;
  }
  const head = element(
    'tr',
    {},
    ...['Website', 'Cookies', 'localStorage', 'IndexedDB'].map((title) =>
      element('th', { textContent: title }),
    ),
  );
  const body = element('tbody');
  for (const [host, entry] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const databases = entry.databases.size
      ? `${entry.databases.size} (${formatSize(entry.databaseBytes)})`
      : '';
    body.append(
      element(
        'tr',
        {},
        element('td', { textContent: host }),
        element('td', { textContent: info.cookies ? String(entry.cookies || '') : '?' }),
        element('td', { textContent: entry.local ? formatSize(entry.local) : '' }),
        element('td', { textContent: databases }),
      ),
    );
  }
  sites.replaceChildren(element('table', {}, element('thead', {}, head), body));
}

function fillLocal(stats: LocalStats, list: HTMLElement): void {
  const item = (label: string, value: string) =>
    list.append(
      element(
        'li',
        {},
        element('span', { textContent: label }),
        element('span', { textContent: value }),
      ),
    );
  for (const database of stats.databases) {
    const host = URL.parse(database.site)?.host || database.site;
    item(`${host}: ${database.kind} (over the limit)`, formatSize(database.size));
  }
  item('Cache of websites (Cache API)', formatSize(stats.cacheStorage));
  if (stats.httpCache != null) item('HTTP cache', formatSize(stats.httpCache));
  item('Service workers', formatSize(stats.serviceWorkers));
  item('Website files (OPFS)', formatSize(stats.pageFiles));
  item('History and open tabs', 'only here');
}

async function resetData(all: boolean, message: HTMLElement): Promise<void> {
  const question = all
    ? 'Reset profile? Everything is deleted: cookies, storage of websites, permissions, settings and bookmarks.'
    : 'Delete site data? Cookies, storage of websites and permissions are deleted; you are signed out everywhere. Settings and bookmarks stay.';
  const local =
    profile.status === 'local'
      ? '\n\nThe profile server cannot be reached: only this device is cleared.'
      : '';
  if (!confirm(question + local)) return;
  try {
    await profile.reset(all);
  } catch (error) {
    message.textContent = (error as Error).message;
    message.hidden = false;
    return;
  }
  await runtime.browser?.storage.clearCaches();
  await profile.prefsSaved();
  reloadUI();
}

// --------------------------------------------------------- device and browser

function renderDevice(section: HTMLElement): void {
  const current = settings();
  const timeZone = text('setting-timezone', current.timeZone, hostTimeZone(), (value, input) => {
    try {
      if (value) Intl.DateTimeFormat(undefined, { timeZone: value });
      input.setCustomValidity('');
      saveSettings({ timeZone: value });
    } catch {
      input.setCustomValidity('Unknown time zone');
      input.reportValidity();
    }
  });
  timeZone.setAttribute('list', 'setting-timezones');
  const zones = element(
    'datalist',
    { id: 'setting-timezones' },
    ...(Intl.supportedValuesOf?.('timeZone') ?? []).map((zone) =>
      element('option', { value: zone }),
    ),
  );
  const restart = element('button', {
    id: 'settings-restart',
    className: 'primary',
    textContent: 'Restart now',
  });
  restart.addEventListener('click', async () => {
    await profile.prefsSaved();
    restartUI();
  });
  section.append(
    row(
      'Device',
      choice(
        'setting-device',
        Object.entries(DEVICES).map(([key, device]) => [key, device.name]),
        current.device,
        save('device', String),
      ),
    ),
    row(
      'User agent',
      text('setting-user-agent', current.userAgent, 'from the device', (value) =>
        saveSettings({ userAgent: value }),
      ),
    ),
    row(
      'Languages of websites',
      text('setting-languages', current.languages, hostLanguages().join(','), (value) =>
        saveSettings({ languages: value }),
      ),
      'for example de-CH,de,en',
    ),
    row('Time zone', timeZone),
    zones,
    row(
      'Color scheme',
      choice(
        'setting-color-scheme',
        [
          ['system', 'System'],
          ['light', 'Light'],
          ['dark', 'Dark'],
        ],
        current.colorScheme,
        save('colorScheme', (value) => value as Settings['colorScheme']),
      ),
    ),
    row(
      'Default zoom',
      choice(
        'setting-zoom',
        ZOOM_LEVELS.map((level) => [level, `${Math.round(level * 100)} %`]),
        current.zoom,
        save('zoom', Number),
      ),
    ),
    row(
      'JavaScript',
      toggle('setting-javascript', current.javascript, (value) =>
        saveSettings({ javascript: value }),
      ),
    ),
    row(
      'Images',
      toggle('setting-images', current.images, (value) => saveSettings({ images: value })),
    ),
    row(
      'Global Privacy Control',
      toggle('setting-gpc', current.gpc, (value) => saveSettings({ gpc: value })),
      'Asks websites not to share or sell your data',
    ),
    row(
      'Data saver',
      toggle('setting-save-data', current.saveData, (value) => saveSettings({ saveData: value })),
      'Asks websites for lighter pages and images',
    ),
    row(
      'Rendering resolution',
      choice(
        'setting-resolution',
        [
          ['full', 'Full'],
          ['balanced', 'Balanced (at most 2x)'],
          ['fast', 'Fast (1x)'],
        ],
        current.resolution,
        save('resolution', (value) => value as Settings['resolution']),
      ),
      'Lower is faster on high resolution screens, text gets slightly softer',
    ),
    row(
      'Limit per database in the profile',
      choice(
        'setting-db-limit',
        DB_LIMITS.map((kb) => [kb, formatSize(kb * 1024)]),
        current.dbLimit,
        save('dbLimit', Number),
      ),
      'Larger databases stay on this device only',
    ),
    element('p', {
      className: 'settings-hint',
      textContent:
        'Another device or user agent can sign you out of websites. Changes apply after a restart.',
    }),
    element('div', { className: 'settings-actions' }, restart),
  );
}
