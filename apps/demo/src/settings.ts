import type { BrowserOptions, ColorScheme } from '@browser-lite/core';
import { DEFAULT_DB_LIMIT_KB } from '@browser-lite/profile';
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

/**
 * The device of the settings that matches the host: on an iPhone or iPad pages get the mobile
 * Safari of that device by default, desktops the engine's own identity.
 */
export function hostDevice(): string {
  if (typeof navigator === 'undefined') return 'desktop';
  if (/iPhone|iPod/.test(navigator.userAgent)) return 'iphone';
  // iPadOS reports a Mac, but with touch
  if (
    /iPad/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1)
  )
    return 'ipad';
  return 'desktop';
}

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
  saveData: boolean;
  resolution: Resolution;
  dbLimit: number;
}

/** Rendering resolution: the pixel ratio of the screen, at most 2, or 1 (BrowserOptions.maxPixelRatio). */
export type Resolution = 'full' | 'balanced' | 'fast';
export const MAX_PIXEL_RATIO: Record<Resolution, number | null> = {
  full: null,
  balanced: 2,
  fast: 1,
};

const DEFAULTS: Settings = {
  searchEngine: 'duckduckgo',
  restoreSession: true,
  homePage: '',
  device: hostDevice(),
  userAgent: '',
  languages: '',
  timeZone: '',
  colorScheme: 'system',
  zoom: 1,
  javascript: true,
  images: true,
  gpc: false,
  saveData: false,
  resolution: 'balanced',
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
  options: Required<
    Pick<
      BrowserOptions,
      | 'userAgent'
      | 'platform'
      | 'languages'
      | 'timeZone'
      | 'colorScheme'
      | 'preferences'
      | 'keepSessionCookies'
    >
  > &
    Pick<BrowserOptions, 'device' | 'maxPixelRatio'>;
}

let start: StartSettings | null = null;

/** Settings of the running start. */
export function startSettings(): StartSettings {
  return start ?? updateStartSettings(false);
}

/**
 * Computes the settings of the running start from the current prefs. `restarted`: "Restart now"
 * or the restart after a crash, which always keep the session.
 */
export function updateStartSettings(restarted: boolean): StartSettings {
  const current = settings();
  const device = DEVICES[current.device] ?? (DEVICES.desktop as DeviceProfile);
  const maxPixelRatio = MAX_PIXEL_RATIO[current.resolution] ?? undefined;
  // The device the host is: its real screen instead of the emulated one, at the resolution of
  // the settings
  const screen =
    device.screen && current.device === hostDevice()
      ? {
          width: window.screen.width,
          height: window.screen.height,
          pixelRatio: Math.min(devicePixelRatio || 1, maxPixelRatio ?? Infinity),
        }
      : device.screen;
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
      ...(screen ? { device: { ...screen, touch: true, mobile: true } } : {}),
      preferences: {
        javascript: current.javascript,
        images: current.images,
        globalPrivacyControl: current.gpc,
        saveData: current.saveData,
      },
      maxPixelRatio,
      // Like Chrome with "Continue where you left off": session cookies stay
      keepSessionCookies: restoreSession,
    },
  };
  return start;
}

/**
 * True when `next` needs another engine than `running`: the time zone, the emulated device and
 * keeping session cookies only apply at the start of the engine.
 */
export function needsNewEngine(running: StartSettings, next: StartSettings): boolean {
  const fixed = ({ options }: StartSettings) =>
    JSON.stringify([options.timeZone, options.device ?? null, options.keepSessionCookies]);
  return fixed(running) !== fixed(next);
}
