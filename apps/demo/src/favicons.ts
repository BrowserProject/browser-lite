import { icon } from './icons.js';
import { element, readJSON } from './util.js';

/**
 * Favicons of the sites visited on this device, per host as 32 px PNG data URLs in localStorage,
 * for history, bookmarks, suggestions and the new tab page (the tabs show the engine's icon).
 */
const KEY = 'bl-favicons';
const MAX_HOSTS = 120;
const SIZE = 32;
// An icon is drawn again after this time, so changed icons come through
const REFRESH = 7 * 24 * 3600 * 1000;

type Store = Record<string, { icon: string; time: number }>;
let store: Store | null = null;

const load = (): Store => {
  store ??= readJSON<Store>(KEY, {});
  return store;
};

/** Host of an http(s) address, '' for anything else. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.host : '';
  } catch {
    return '';
  }
}

/** Remembers the icon of the page at `url`; `src` is the object URL the tab shows. */
export function rememberIcon(url: string, src: string): void {
  const host = hostOf(url);
  const known = load()[host];
  if (!host || (known && Date.now() - known.time < REFRESH)) return;
  const image = new Image();
  image.src = src;
  image
    .decode()
    .then(() => {
      const canvas = element('canvas', { width: SIZE, height: SIZE });
      canvas.getContext('2d')?.drawImage(image, 0, 0, SIZE, SIZE);
      const entries = load();
      entries[host] = { icon: canvas.toDataURL('image/png'), time: Date.now() };
      const hosts = Object.keys(entries);
      if (hosts.length > MAX_HOSTS) {
        hosts.sort((a, b) => (entries[a]?.time ?? 0) - (entries[b]?.time ?? 0));
        for (const old of hosts.slice(0, hosts.length - MAX_HOSTS)) delete entries[old];
      }
      localStorage.setItem(KEY, JSON.stringify(entries));
    })
    // An icon that does not decode, or a full or blocked storage: the globe stays
    .catch(() => {});
}

/** The remembered icon of the host of `url`, else a globe. */
export function favicon(url: string, className = 'favicon'): HTMLElement | SVGSVGElement {
  const known = load()[hostOf(url)];
  if (!known) {
    const globe = icon('globe');
    globe.classList.add(className);
    return globe;
  }
  return element('img', { className, src: known.icon, alt: '', decoding: 'async' });
}

/** Forgets every icon (with the history). */
export function clearIcons(): void {
  store = {};
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
