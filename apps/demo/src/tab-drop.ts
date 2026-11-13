import { addressToLoad } from './address-bar.js';
import { acceptText, droppedText } from './dropped-text.js';
import { activate, allTabs, loadInTab, openTab, type Tab } from './tabs.js';
import { byId } from './util.js';

/**
 * Links and text dropped on the tab strip, like Chrome: on a tab they load in that tab, on the
 * free part of the strip or the new tab button in a new tab at the end. Text is searched like in
 * the address bar.
 */
export function initTabDrop(): void {
  const strip = byId('tabs');
  let marked: Tab | null = null;
  const mark = (tab: Tab | null) => {
    marked?.element.classList.remove('drop-target');
    marked = tab;
    tab?.element.classList.add('drop-target');
  };
  const tabAt = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest('.tab') : null;
    return allTabs().find((tab) => tab.element === node) ?? null;
  };
  strip.addEventListener('dragover', (e) => mark(acceptText(e) ? tabAt(e.target) : null));
  strip.addEventListener('dragleave', () => mark(null));
  strip.addEventListener('drop', (e) => {
    mark(null);
    e.preventDefault();
    const url = addressToLoad(droppedText(e.dataTransfer));
    if (!url) return;
    const tab = tabAt(e.target);
    if (!tab) {
      openTab(url);
      return;
    }
    activate(tab);
    loadInTab(tab, url);
  });
}
