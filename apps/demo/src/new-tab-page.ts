import { focusAddress } from './address-bar.js';
import { bookmarks } from './bookmarks.js';
import { favicon, hostOf } from './favicons.js';
import { readHistory } from './history.js';
import { activeTab, loadInTab, onTabsChange, openTab } from './tabs.js';
import { byId, element } from './util.js';

const page = byId('new-tab-page');
const tiles = page.querySelector('.ntp-tiles') as HTMLElement;
const greeting = page.querySelector('.ntp-greeting') as HTMLElement;
const TILES = 8;

/**
 * The sites for the tiles: visited often and lately, bookmarks count as visits. One tile per host
 * (google.com and a search there are one site), with its address used most.
 */
export function frequentSites(limit = TILES): { url: string; title: string }[] {
  const now = Date.now();
  const hosts = new Map<
    string,
    { points: number; pages: Map<string, { title: string; points: number }> }
  >();
  const add = (url: string, title: string, points: number) => {
    const host = hostOf(url).replace(/^www\./, '');
    if (!host) return;
    const site = hosts.get(host) ?? { points: 0, pages: new Map() };
    const page = site.pages.get(url) ?? { title, points: 0 };
    site.points += points;
    page.points += points;
    if (title) page.title = title;
    site.pages.set(url, page);
    hosts.set(host, site);
  };
  for (const visit of readHistory())
    add(visit.url, visit.title, 1 + Math.max(0, 1 - (now - visit.time) / (30 * 86400000)));
  for (const bookmark of bookmarks()) add(bookmark.url, bookmark.title, 3);
  return [...hosts.values()]
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((site) => {
      // Every host has at least one page
      const [url, page] = [...site.pages].sort((a, b) => b[1].points - a[1].points)[0] as [
        string,
        { title: string },
      ];
      return { url, title: page.title };
    });
}

/** "Good morning", "Good afternoon" or "Good evening" at `hour`. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The remembered icon of the site, else its first letter on a color of its host. */
function tileIcon(url: string): Element {
  const known = favicon(url);
  if (known instanceof HTMLImageElement) return known;
  const host = hostOf(url).replace(/^www\./, '');
  let hue = 0;
  for (const char of host) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  const letter = element('span', {
    className: 'ntp-letter',
    textContent: (host[0] ?? '?').toUpperCase(),
  });
  letter.style.setProperty('--hue', String(hue));
  return letter;
}

function tile(site: { url: string; title: string }): HTMLElement {
  const link = element(
    'a',
    { className: 'ntp-tile', href: site.url, title: site.url },
    element('span', { className: 'ntp-tile-icon' }, tileIcon(site.url)),
    element('span', {
      className: 'ntp-tile-title',
      textContent: site.title || hostOf(site.url).replace(/^www\./, ''),
    }),
  );
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = activeTab();
    if (e.ctrlKey || e.metaKey || !tab) openTab(site.url);
    else loadInTab(tab, site.url);
  });
  return link;
}

function render(): void {
  greeting.textContent = greetingFor(new Date().getHours());
  const sites = frequentSites();
  tiles.replaceChildren(...sites.map(tile));
  tiles.hidden = !sites.length;
}

/**
 * The new tab page, drawn by the demo over the blank view of a new tab (no request to the
 * engine): a greeting, a search field that hands over to the address bar like Chrome's, and
 * tiles of the sites visited most often (their icon, else their first letter).
 */
export function initNewTabPage(): void {
  page.querySelector('.ntp-search')?.addEventListener('click', () => focusAddress());
  onTabsChange(() => {
    const show = !!activeTab()?.newTab;
    if (show && page.hidden) render();
    page.hidden = !show;
  });
}
