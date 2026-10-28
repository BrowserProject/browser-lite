import {
  activate,
  activeTab,
  allTabs,
  onTabsChange,
  openURL,
  requestClose,
  type Tab,
} from './tabs.js';
import { byId, element } from './util.js';

const overview = byId('tab-overview');
const grid = overview.querySelector('.overview-grid') as HTMLElement;
const count = byId('tab-count');
const countText = count.firstElementChild as HTMLElement;

/**
 * Tab overview of the phone layout, like the tab switcher of mobile Chrome and Safari: a card
 * per tab with icon, title and address, a tap switches, the cross closes; the toolbar button
 * shows the number of tabs and opens it.
 */
export function initTabOverview(): void {
  count.addEventListener('click', () => toggleOverview(!overviewOpen()));
  overview.querySelector('.overview-done')?.addEventListener('click', () => toggleOverview(false));
  overview.querySelector('.overview-new')?.addEventListener('click', () => {
    toggleOverview(false);
    openURL('', true);
  });
  onTabsChange(() => {
    const tabs = allTabs().length;
    countText.textContent = tabs > 99 ? ':D' : String(tabs);
    count.title = `${tabs} ${tabs === 1 ? 'tab' : 'tabs'}`;
    if (!overview.hidden) render();
  });
}

export const overviewOpen = (): boolean => !overview.hidden;

/** Opens or closes the overview. */
export function toggleOverview(open: boolean): void {
  overview.hidden = !open;
  if (open) {
    render();
    grid.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function card(tab: Tab): HTMLElement {
  const icon = element('img', { className: 'overview-icon', alt: '' });
  icon.hidden = !tab.iconUrl;
  if (tab.iconUrl) icon.src = tab.iconUrl;
  icon.onerror = () => {
    icon.hidden = true;
  };
  const open = element(
    'button',
    { className: 'overview-open', type: 'button' },
    icon,
    element('span', {
      className: 'overview-title',
      textContent: tab.title || tab.url || 'New tab',
    }),
    element('span', { className: 'overview-url', textContent: hostOf(tab.url) }),
  );
  open.addEventListener('click', () => {
    toggleOverview(false);
    activate(tab);
  });
  const close = element('button', {
    className: 'overview-close',
    type: 'button',
    title: 'Close tab',
    textContent: '×',
  });
  close.addEventListener('click', () => requestClose(tab));
  const node = element('div', { className: 'overview-card' }, open, close);
  node.classList.toggle('active', tab === activeTab());
  return node;
}

function render(): void {
  const tabs = allTabs();
  const label = overview.querySelector('.overview-count');
  if (label) label.textContent = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
  grid.replaceChildren(...tabs.map(card));
}
