/**
 * The back and forward of the host browser (its buttons, the mouse buttons, the iOS edge swipes,
 * the Android back gesture) go back and forward in the tab in front, like in an in-app browser.
 *
 * The demo keeps up to three entries of its own in the host history: `base`, the entry it loaded
 * at, `guard` on top of it and `ahead` on top of `guard`. While the tab can go back the host is on
 * `guard`, so a host back lands on `base` in the same document (a `popstate`) and the tab goes
 * back; the demo then returns to `guard` with `history.forward()`. Only when the tab has no back
 * entry the host stays on `base`, and the next host back leaves the demo. A host move up (from
 * `base` to `guard`, from `guard` to `ahead`) goes forward in the tab, and the demo returns to
 * the entry it wants.
 *
 * `guard` is pushed once per document, in the handler of the first user action: Chrome skips the
 * entry a page pushed from without a user action on its back button, Safari the entry pushed
 * more than 10 s after one together with the entry below it. `ahead` is pushed from `guard` the
 * first time the tab can go forward there, and once more in the next user action when that push
 * had none, as Safari's forward skips an entry pushed without one. Otherwise the demo only moves
 * between its entries, which no browser counts against it.
 */

/** The tab the host back and forward act on. */
export interface HistoryTarget {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  back(): void;
  forward(): void;
}

const PLACES = ['base', 'guard', 'ahead'] as const;
type Place = (typeof PLACES)[number];

const KEY = 'blHost';
// The events that give the page a user activation, depending on browser and pointer
const USER_ACTIONS = ['keydown', 'pointerdown', 'pointerup', 'touchend', 'click'] as const;

let target: () => HistoryTarget | null = () => null;
let current: Place = 'base';
/** `guard` is above `base` (pushed in this document). */
let guardPushed = false;
/** `ahead` is above `guard`: `active` when pushed in a user action. */
let ahead: 'none' | 'inactive' | 'active' = 'none';
/** Where a traversal of the demo goes; its `popstate` is no user action. */
let pending: Place | null = null;

const placeOf = (state: unknown): Place | null => {
  const place = (state as Record<string, unknown> | null)?.[KEY];
  return PLACES.find((p) => p === place) ?? null;
};

// Not every event of the list activates (a pointerup after scrolling does not)
const activated = (): boolean => navigator.userActivation?.isActive !== false;

function onUserAction(): void {
  if (!activated()) return;
  if (!guardPushed) {
    history.pushState({ [KEY]: 'guard' }, '');
    guardPushed = true;
    current = 'guard';
  }
  syncHostHistory();
}

function traverse(to: Place): void {
  pending = to;
  history.go(PLACES.indexOf(to) - PLACES.indexOf(current));
}

/**
 * Moves the host to `guard` while the tab in front can go back, else to `base`, and gives it
 * `ahead` while the tab can go forward.
 */
export function syncHostHistory(): void {
  if (!guardPushed || pending) return;
  const tab = target();
  const want: Place = tab?.canGoBack ? 'guard' : 'base';
  if (want !== current) {
    traverse(want);
    return;
  }
  const push = ahead === 'none' || (ahead === 'inactive' && activated());
  if (current === 'guard' && tab?.canGoForward && push) {
    ahead = activated() ? 'active' : 'inactive';
    history.pushState({ [KEY]: 'ahead' }, '');
    current = 'ahead';
    traverse('guard');
  }
}

function onPopState(event: PopStateEvent): void {
  const place = placeOf(event.state);
  // Only the entries of the demo share this document
  if (!place) return;
  const move = PLACES.indexOf(place) - PLACES.indexOf(current);
  current = place;
  const own = pending === place;
  pending = null;
  if (!own) {
    const tab = target();
    if (move < 0 && tab?.canGoBack) tab.back();
    else if (move > 0 && tab?.canGoForward) tab.forward();
  }
  syncHostHistory();
}

/**
 * Lets the host back and forward act on `active`, the tab in front; call syncHostHistory after
 * its back or forward state or the tab in front changed.
 */
export function followHostHistory(active: () => HistoryTarget | null): void {
  target = active;
  // Also after a reload at a former entry above: the entries of the earlier document load anew
  history.replaceState({ [KEY]: 'base' }, '');
  window.addEventListener('popstate', onPopState);
  // Back in the document from the back/forward cache, maybe at another entry (Chrome skips
  // `guard` on its back button when `ahead` was pushed without a user action)
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    current = placeOf(history.state) ?? current;
    pending = null;
    syncHostHistory();
  });
  for (const type of USER_ACTIONS) window.addEventListener(type, onUserAction, true);
}
