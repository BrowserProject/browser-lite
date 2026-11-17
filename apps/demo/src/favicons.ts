import { icon } from './icons.js';
import { element, readJSON } from './util.js';

/**
 * Favicons of the pages visited on this device like Chrome's favicon database, for history,
 * bookmarks, suggestions, the new tab page and the tabs that have not loaded yet (a loaded tab
 * shows the engine's icon). Each icon is kept once as a 32 px PNG data URL in localStorage under
 * a hash of the engine's bytes; pages map to their icon, and each host to its latest one for
 * addresses whose page was never seen.
 */
const KEY = 'bl-favicons';
const MAX_PAGES = 1000;
const MAX_HOSTS = 120;
const MAX_ICONS = 200;
const SIZE = 32;

/** An icon by hash, or '' for a page without one; `time` is the last use. */
type Ref = { icon: string; time: number };
interface Store {
  /** 32 px PNG data URLs by hash. */
  icons: Record<string, string>;
  pages: Record<string, Ref>;
  hosts: Record<string, Ref>;
}
let store: Store | null = null;
/** The newest report per page, so an older one that finishes later does not win. */
const pending = new Map<string, number>();
let reports = 0;

const empty = (): Store => ({ icons: {}, pages: {}, hosts: {} });

const load = (): Store => {
  if (!store) {
    const saved = readJSON<Partial<Store>>(KEY, {});
    store = saved.icons && saved.pages && saved.hosts ? (saved as Store) : empty();
  }
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

/** The key of the page of an http(s) address (without its fragment, the same document), else ''. */
function pageOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/** A 53 bit hash of the icon's bytes (cyrb53), the name of the icon in the store. */
function hashOf(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef ^ bytes.length;
  let h2 = 0x41c6ce57 ^ bytes.length;
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The 32 px PNG data URL of an icon, null when it does not decode. */
async function draw(blob: Blob): Promise<string | null> {
  const src = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = element('canvas', { width: SIZE, height: SIZE });
    // A CPU canvas: the readback of a GPU one waits for the GL work of the engine's view and
    // blocks the host main thread (UI and network) for up to seconds
    canvas.getContext('2d', { willReadFrequently: true })?.drawImage(image, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Keeps the newest `max` entries of `refs`. */
function trim(refs: Record<string, Ref>, max: number): void {
  const keys = Object.keys(refs);
  if (keys.length <= max) return;
  keys.sort((a, b) => (refs[a]?.time ?? 0) - (refs[b]?.time ?? 0));
  for (const key of keys.slice(0, keys.length - max)) delete refs[key];
}

/** Drops the icons no page or host uses, then the least recently used beyond MAX_ICONS. */
function collectIcons(entries: Store): void {
  const lastUse = new Map<string, number>();
  for (const ref of [...Object.values(entries.pages), ...Object.values(entries.hosts)])
    lastUse.set(ref.icon, Math.max(lastUse.get(ref.icon) ?? 0, ref.time));
  for (const name of Object.keys(entries.icons)) if (!lastUse.has(name)) delete entries.icons[name];
  const names = Object.keys(entries.icons);
  if (names.length <= MAX_ICONS) return;
  names.sort((a, b) => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0));
  const dropped = new Set(names.slice(0, names.length - MAX_ICONS));
  for (const name of dropped) delete entries.icons[name];
  for (const map of [entries.pages, entries.hosts])
    for (const [key, ref] of Object.entries(map)) if (dropped.has(ref.icon)) delete map[key];
}

function save(entries: Store): void {
  trim(entries.pages, MAX_PAGES);
  trim(entries.hosts, MAX_HOSTS);
  collectIcons(entries);
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked storage: the icons stay in memory for this session
  }
}

/**
 * Remembers the icon the engine reported for the page at `url`, null for a page without one.
 * The page shows it from then on, its host for addresses whose page was never seen. A changed
 * icon replaces the old one at once; the same bytes are drawn only once.
 */
export function rememberIcon(url: string, blob: Blob | null): void {
  const page = pageOf(url);
  if (!page) return;
  const report = ++reports;
  pending.set(page, report);
  (async () => {
    const name = blob ? hashOf(new Uint8Array(await blob.arrayBuffer())) : '';
    const known = name ? load().icons[name] : undefined;
    const data = known ?? (name ? await draw(blob as Blob) : null);
    if (pending.get(page) !== report) return;
    pending.delete(page);
    const entries = load();
    // An icon that does not decode is none, like in the tab
    const shown = data ? name : '';
    const host = hostOf(url);
    const changed =
      (data && !known) ||
      entries.pages[page]?.icon !== shown ||
      (data && entries.hosts[host]?.icon !== shown);
    const time = Date.now();
    entries.pages[page] = { icon: shown, time };
    if (data) {
      entries.icons[shown] = data;
      entries.hosts[host] = { icon: shown, time };
    }
    // The same icon again only moves the times in memory: no write for every visit
    if (changed) save(entries);
  })().catch(() => {});
}

/**
 * The remembered icon of the page at `url` as a data URL, else the latest one of its host for a
 * page never seen; null without one (a page without an icon has none, like in Chrome).
 */
export function rememberedIcon(url: string): string | null {
  const entries = load();
  const ref = entries.pages[pageOf(url)] ?? entries.hosts[hostOf(url)];
  return (ref?.icon && entries.icons[ref.icon]) || null;
}

/** Forgets the icon of the page at `url` (removed from the history); its host keeps its own. */
export function forgetPageIcon(url: string): void {
  const entries = load();
  const page = pageOf(url);
  if (!entries.pages[page]) return;
  delete entries.pages[page];
  save(entries);
}

/** Like Chrome's default favicon a globe, for a page without an icon of its own. */
export function defaultFavicon(className = 'favicon'): SVGSVGElement {
  const globe = icon('globe');
  globe.classList.add(className);
  return globe;
}

/** The remembered icon of the page at `url` (see {@link rememberedIcon}), else a globe. */
export function favicon(url: string, className = 'favicon'): HTMLElement | SVGSVGElement {
  const src = rememberedIcon(url);
  if (!src) return defaultFavicon(className);
  return element('img', { className, src, alt: '', decoding: 'async' });
}

/** Forgets every icon (with the history). */
export function clearIcons(): void {
  store = empty();
  pending.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
