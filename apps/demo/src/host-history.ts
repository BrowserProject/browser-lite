/**
 * The back and forward of the host browser (its buttons, the iOS edge swipe, the Android back
 * gesture) go back and forward in the tab in front, like in an in-app browser.
 *
 * The demo keeps two entries of its own in the host history: `base`, the entry it loaded at, and
 * `guard` on top of it. While the tab can go back the host is on `guard`, so a host back lands on
 * `base` in the same document (a `popstate`) and the tab goes back; the demo then returns to
 * `guard` with `history.forward()`. Only when the tab has no back entry the host stays on `base`,
 * and the next host back leaves the demo. A host forward from `base` to `guard` (after a back to
 * the tab's first entry) goes forward in the tab.
 *
 * `guard` is pushed once per document, in the handler of the first user action: Chrome skips the
 * entry a page pushed from without a user action on its back button, Safari the entry pushed
 * more than 10 s after one together with the entry below it. Afterwards the demo only moves
 * between the two entries, which no browser counts against it.
 */

/** The tab the host back and forward act on. */
export interface HistoryTarget {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  back(): void;
  forward(): void;
}

type Place = 'base' | 'guard';

const KEY = 'blHost';
// The events that give the page a user activation, depending on browser and pointer
const USER_ACTIONS = ['keydown', 'pointerdown', 'pointerup', 'touchend', 'click'] as const;

let target: () => HistoryTarget | null = () => null;
let current: Place = 'base';
/** `guard` is above `base` (pushed in this document). */
let guardPushed = false;
/** Where a traversal of the demo goes; its `popstate` is no user action. */
let pending: Place | null = null;

const placeOf = (state: unknown): Place | null => {
  const place = (state as Record<string, unknown> | null)?.[KEY];
  return place === 'base' || place === 'guard' ? place : null;
};

function pushGuard(): void {
  // Not every event of the list activates (a pointerup after scrolling does not)
  if (guardPushed || navigator.userActivation?.isActive === false) return;
  for (const type of USER_ACTIONS) window.removeEventListener(type, pushGuard, true);
  history.pushState({ [KEY]: 'guard' }, '');
  guardPushed = true;
  current = 'guard';
  syncHostHistory();
}

function traverse(to: Place): void {
  pending = to;
  history.go(to === 'guard' ? 1 : -1);
}

/** Moves the host to `guard` while the tab in front can go back, else to `base`. */
export function syncHostHistory(): void {
  const want: Place = target()?.canGoBack ? 'guard' : 'base';
  if (guardPushed && !pending && want !== current) traverse(want);
}

function onPopState(event: PopStateEvent): void {
  const place = placeOf(event.state);
  // Only base and guard share this document
  if (!place) return;
  const from = current;
  current = place;
  const own = pending === place;
  pending = null;
  if (!own) {
    const tab = target();
    if (from === 'guard' && place === 'base' && tab?.canGoBack) tab.back();
    else if (from === 'base' && place === 'guard' && tab?.canGoForward) tab.forward();
  }
  syncHostHistory();
}

/**
 * Lets the host back and forward act on `active`, the tab in front; call syncHostHistory after
 * its back or forward state or the tab in front changed.
 */
export function followHostHistory(active: () => HistoryTarget | null): void {
  target = active;
  // Also after a reload at the former guard: the entries of the earlier document load anew
  history.replaceState({ [KEY]: 'base' }, '');
  window.addEventListener('popstate', onPopState);
  for (const type of USER_ACTIONS) window.addEventListener(type, pushGuard, true);
}
