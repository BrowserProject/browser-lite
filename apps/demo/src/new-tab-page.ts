import { focusAddress } from './address-bar.js';
import { bookmarks } from './bookmarks.js';
import { favicon, hostOf } from './favicons.js';
import { readHistory } from './history.js';
import { activeTab, loadInTab, onTabsChange, openTab } from './tabs.js';
import { byId, element } from './util.js';

const page = byId('new-tab-page');
const tiles = page.querySelector('.ntp-tiles') as HTMLElement;
const TILES = 8;

/** The sites for the tiles: visited often and lately, bookmarks count as visits. */
export function frequentSites(limit = TILES): { url: string; title: string }[] {
  const now = Date.now();
  const sites = new Map<string, { url: string; title: string; points: number }>();
  const add = (url: string, title: string, points: number) => {
    if (!hostOf(url)) return;
    const site = sites.get(url) ?? { url, title, points: 0 };
    site.points += points;
    if (title) site.title = title;
    sites.set(url, site);
  };
  for (const visit of readHistory())
    add(visit.url, visit.title, 1 + Math.max(0, 1 - (now - visit.time) / (30 * 86400000)));
  for (const bookmark of bookmarks()) add(bookmark.url, bookmark.title, 3);
  return [...sites.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

function tile(site: { url: string; title: string }): HTMLElement {
  const link = element(
    'a',
    { className: 'ntp-tile', href: site.url, title: site.url },
    element('span', { className: 'ntp-tile-icon' }, favicon(site.url)),
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
  const sites = frequentSites();
  tiles.replaceChildren(...sites.map(tile));
  tiles.hidden = !sites.length;
}

/**
 * The new tab page, drawn by the demo over the blank view of a new tab (no request to the
 * engine): a search field that hands over to the address bar like Chrome's, and tiles of the
 * sites visited most often.
 */
export function initNewTabPage(): void {
  page.querySelector('.ntp-search')?.addEventListener('click', () => focusAddress());
  onTabsChange(() => {
    const show = !!activeTab()?.newTab;
    if (show && page.hidden) render();
    page.hidden = !show;
  });
}
