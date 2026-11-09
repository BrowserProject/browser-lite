import type { ViewEvents } from '@browser-lite/core';
import { compactLayout } from './layout.js';
import { activeTab, onTabCreated, onTabsChange, type Tab } from './tabs.js';
import { byId } from './util.js';

// How far the user scrolls in one direction before the bar goes or comes back: a finger that
// drifts a little during a tap moves nothing
const THRESHOLD = 20;

type BarState = 'shown' | 'hidden' | 'showing';

/**
 * Like mobile Chrome's browser controls, the bottom bar of the phone layout (`#chrome`) slides
 * away while the user scrolls the page of the tab in front down (the view's `scroll` event with
 * `user`) and comes back when they scroll up, the page is at its top, a new document commits,
 * another tab comes to the front or the focus goes into the bar (keyboard shortcuts, Tab). Only
 * scrolls by the user count, not those of the page's script or a restored position.
 *
 * The page area takes the bar's room in one step, so the page is laid out at most once per
 * change of direction: hiding gives it the room at once while the bar slides away over it
 * (`body[data-bar="hidden"]`); showing slides the bar in over the page first and gives the room
 * back once it is there (`showing`, then `shown`). style.css applies the states only in the
 * phone layout.
 */
export function hideBarWhileScrolling(): void {
  const chrome = byId('chrome');
  let state: BarState = 'shown';
  let front: Tab | null = null;
  let lastY: number | null = null;
  // Distance scrolled by the user in the current direction (negative: up)
  let run = 0;

  const set = (next: BarState) => {
    state = next;
    if (next === 'shown') delete document.body.dataset.bar;
    else document.body.dataset.bar = next;
  };
  const settled = () => {
    if (state === 'showing') set('shown');
  };
  const show = () => {
    run = 0;
    if (state !== 'hidden') return;
    set('showing');
    // Without a transition (reduced motion, the desktop layout) there is no transitionend
    const duration = getComputedStyle(chrome).transitionDuration.split(',');
    if (duration.every((value) => Number.parseFloat(value) === 0)) settled();
  };
  const hide = () => {
    run = 0;
    if (state === 'hidden' || !compactLayout() || chrome.contains(document.activeElement)) return;
    set('hidden');
  };
  const scrolled = (event: ViewEvents['scroll']) => {
    const delta = lastY === null ? 0 : event.y - lastY;
    lastY = event.y;
    if (event.y <= 0) return show();
    if (!event.user || !delta) return;
    run = Math.sign(delta) === Math.sign(run) ? run + delta : delta;
    if (run >= THRESHOLD) hide();
    else if (run <= -THRESHOLD) show();
  };

  chrome.addEventListener('transitionend', (e) => {
    if (e.target === chrome && e.propertyName === 'translate') settled();
  });
  chrome.addEventListener('focusin', show);
  onTabCreated((tab) => {
    tab.view.on('scroll', (event) => {
      if (tab.isActive) scrolled(event);
    });
    tab.view.on('commit', () => {
      if (!tab.isActive) return;
      lastY = null;
      show();
    });
  });
  onTabsChange(() => {
    const tab = activeTab();
    if (tab === front) return;
    front = tab;
    lastY = null;
    show();
  });
  // Leaving the phone layout (rotation of a tablet, a wider window) brings the bar back at once
  addEventListener('resize', () => {
    if (state !== 'shown' && !compactLayout()) set('shown');
  });
}
