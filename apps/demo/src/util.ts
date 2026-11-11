/** Small helpers shared by the modules of the demo. */

/**
 * Reads and writes localStorage (sessionStorage with `session`); `null` deletes, `undefined`
 * only reads. When the storage is blocked (private mode, site settings) nothing is kept.
 */
export function storage(key: string, value?: string | null, session = false): string | null {
  try {
    const area = session ? sessionStorage : localStorage;
    if (value === null) area.removeItem(key);
    else if (value !== undefined) area.setItem(key, value);
    return area.getItem(key);
  } catch {
    return value ?? null;
  }
}

/** JSON value of a localStorage key, `fallback` when missing or broken. */
export function readJSON<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Element of index.html by id (throws when missing: the page and the code belong together). */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing in index.html`);
  return node as T;
}

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>
>;

/** Element with properties (textContent, className, ...) and children. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The address of the new tab page: an empty document the engine loads like about:blank, so the
 * page is an entry of the tab's back and forward like Chrome's, and the demo draws its new tab
 * page over it.
 */
export const NEW_TAB_URL = 'about:blank#new-tab';

/** The new tab page, see NEW_TAB_URL. */
export const isNewTabPage = (url: string | null | undefined): boolean => url === NEW_TAB_URL;

/** No page yet: a new tab before its first address, or the new tab page. */
export const isBlank = (url: string | null | undefined): boolean =>
  !url || url === 'about:blank' || isNewTabPage(url);

/** Internal pages that never go into history, session or bookmarks. */
export const isInternal = (url: string | null | undefined): boolean =>
  isBlank(url) || !!url?.startsWith('data:') || !!url?.startsWith('blob:');
