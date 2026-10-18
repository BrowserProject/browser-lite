import type { BrowserOptions, ColorScheme } from '@browser-lite/core';
import { DEFAULT_DB_LIMIT_KB } from '@browser-lite/profile';
import { takeRestart } from './reload.js';
import { profile } from './runtime.js';

/** Search engines of the address bar; `%s` is the query. */
export const SEARCH_ENGINES: Record<string, { name: string; url: string }> = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/html/?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
};

/** Zoom levels like Chrome. */
export const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

interface DeviceProfile {
  name: string;
  userAgent: string;
  platform: string;
  /** Emulated screen in CSS pixels with pixel ratio; desktops use the host screen. */
  screen?: { width: number; height: number; pixelRatio: number };
}

// Only WebKit (Safari) user agents; the default is the one of the engine (Linux). The iPad
// reports itself as a Mac like real iPadOS, so sites see what they see on an iPad and detect it
// by navigator.maxTouchPoints like there.
const SAFARI = 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0';
const MAC_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI} Safari/605.1.15`;

/** Devices of the settings; one with a screen is a mobile device with touch. */
export const DEVICES: Record<string, DeviceProfile> = {
  desktop: { name: 'Desktop (Linux)', userAgent: '', platform: '' },
  mac: { name: 'Mac', userAgent: MAC_UA, platform: 'MacIntel' },
  iphone: {
    name: 'iPhone',
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ${SAFARI} Mobile/15E148 Safari/604.1`,
    platform: 'iPhone',
    screen: { width: 390, height: 844, pixelRatio: 3 },
  },
  ipad: {
    name: 'iPad',
    userAgent: MAC_UA,
    platform: 'MacIntel',
    screen: { width: 820, height: 1180, pixelRatio: 2 },
  },
};

/** Size limits per database in the profile (KB). */
export const DB_LIMITS = [128, 256, 512, 1024, 4096];

/** The pref `settings` of the profile. */
export interface Settings {
  searchEngine: string;
  restoreSession: boolean;
  homePage: string;
  device: string;
  userAgent: string;
  languages: string;
  timeZone: string;
  colorScheme: ColorScheme;
  zoom: number;
  javascript: boolean;
  images: boolean;
  gpc: boolean;
  dbLimit: number;
}

const DEFAULTS: Settings = {
  searchEngine: 'duckduckgo',
  restoreSession: true,
  homePage: '',
  device: 'desktop',
  userAgent: '',
  languages: '',
  timeZone: '',
  colorScheme: 'system',
  zoom: 1,
  javascript: true,
  images: true,
  gpc: false,
  dbLimit: DEFAULT_DB_LIMIT_KB,
};

/** Current settings (changes to start options apply after a restart). */
export function settings(): Settings {
  return { ...DEFAULTS, ...profile.prefs<Partial<Settings>>('settings') };
}

export function saveSettings(changes: Partial<Settings>): void {
  profile.savePrefs('settings', { ...profile.prefs<Partial<Settings>>('settings'), ...changes });
}

/** Languages of the host without suffixes like "@posix" that the engine does not know. */
export const hostLanguages = (): string[] =>
  (navigator.languages?.length ? navigator.languages : [navigator.language]).map(
    (language) => language.split('@')[0] ?? language,
  );
export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What applies from the start of the engine. */
export interface StartSettings {
  device: DeviceProfile;
  zoom: number;
  restoreSession: boolean;
  /** Options of createBrowser. */
  options: Pick<
    BrowserOptions,
    | 'userAgent'
    | 'platform'
    | 'languages'
    | 'timeZone'
    | 'colorScheme'
    | 'device'
    | 'preferences'
    | 'keepSessionCookies'
  >;
}

let start: StartSettings | null = null;

/** Settings of this start (computed once, after the profile prefs arrived). */
export function startSettings(): StartSettings {
  if (start) return start;
  const current = settings();
  const device = DEVICES[current.device] ?? (DEVICES.desktop as DeviceProfile);
  // "Restart now" and the restart after a crash always keep the session
  const restarted = takeRestart();
  const restoreSession = current.restoreSession || restarted;
  const languages = current.languages
    .split(',')
    .map((language) => language.trim())
    .filter((language) => /^[A-Za-z0-9-]+$/.test(language));
  start = {
    device,
    zoom: current.zoom,
    restoreSession,
    options: {
      userAgent: current.userAgent.trim() || device.userAgent,
      platform: device.platform,
      languages: languages.length ? languages : hostLanguages(),
      timeZone: current.timeZone.trim() || hostTimeZone(),
      colorScheme: current.colorScheme,
      ...(device.screen ? { device: { ...device.screen, touch: true, mobile: true } } : {}),
      preferences: {
        javascript: current.javascript,
        images: current.images,
        globalPrivacyControl: current.gpc,
      },
      // Like Chrome with "Continue where you left off": session cookies stay
      keepSessionCookies: restoreSession,
    },
  };
  return start;
}

/** Computes the start settings again at the next start (restart in the page). */
export function resetStartSettings(): void {
  start = null;
}
