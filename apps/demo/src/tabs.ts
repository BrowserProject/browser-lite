import type { SessionHistory, SkippedFile, View, ViewEvents } from '@browser-lite/core';
import { defaultMenuItems, linkStatus, showContextMenu, slotMenuItems } from '@browser-lite/ui';
import { addBlockedPopup, type BlockedPopup, updatePopupsButton } from './blocked-popups.js';
import { rememberClosed, takeClosed } from './closed-tabs.js';
import { ui } from './extensions.js';
import { hostOf, rememberIcon } from './favicons.js';
import { endFind, showFindCount, showFindOf } from './find-bar.js';
import { recordVisit } from './history.js';
import { syncHostHistory } from './host-history.js';
import { icon, setIcon } from './icons.js';
import { compactLayout } from './layout.js';
import { debug } from './params.js';
import { printing, showPreview } from './print-preview.js';
import { focusPrompt, showPromptsOf } from './prompts.js';
import { uiReloading } from './reload.js';
import { runtime } from './runtime.js';
import { type SessionEntry, type SessionTab, saveSession, sessionEntry } from './session.js';
import { settings, startSettings } from './settings.js';
import {
  setProgress,
  setStatus,
  showSnackbar,
  updateSecurity,
  updateStar,
  updateToolbar,
} from './toolbar.js';
import { byId, element, isBlank, isInternal } from './util.js';
import { sourcePage } from './view-source.js';
import { rememberSiteZoom, siteZoom, zoomHost } from './zoom.js';

const list: Tab[] = [];
let active: Tab | null = null;
const created = new Set<(tab: Tab) => void>();
const changeListeners = new Set<() => void>();

const pages = () => byId('pages');

/** One tab of the demo: a view of the core with its element in the tab strip. */
export class Tab implements SessionTab {
  readonly element: HTMLDivElement;
  readonly view: View;
  url: string;
  title: string;
  history: SessionHistory | null;
  /** Restored or discarded tab: loads on the first activation. */
  pending: { url: string; history: SessionHistory | null } | null = null;
  canGoBack = false;
  canGoForward = false;
  loading = false;
  zoom: number;
  /** Host the zoom of the tab belongs to (see zoom.ts), null before the first address. */
  zoomHost: string | null = null;
  /** Kind of error page of the current document (for example 'certificate'), null without. */
  errorPage: string | null = null;
  /** Shown in the status line after the next load. */
  notice: string | null = null;
  capturing = false;
  pictureInPicture = false;
  hasBeforeUnload = false;
  /** Click, key or text in the current document (beforeunload asks only then). */
  userActivated = false;
  /** Closing waits for the beforeunload answer; afterwards closeReturn becomes active. */
  closing = false;
  closeReturn: Tab | null = null;
  /**
   * Tab that was active when this one opened in front; closing this tab before another tab was
   * active returns to it, like Chrome and Firefox.
   */
  opener: Tab | null = null;
  /**
   * Tab whose link opened this one; the next tabs it opens from links come after this one, like
   * Chrome. Forgotten when an address is loaded from the address bar or a panel.
   */
  openedBy: Tab | null = null;
  /** Discarded: a tab in its place took over, closing the view is no closing by the user. */
  replaced = false;
  /** Dialogs of the current document blocked by the user, or skipped in the background. */
  dialogsBlocked = false;
  dialogSuppressed = false;
  /** Popups the current document could not open (no user gesture). */
  blockedPopups: BlockedPopup[] = [];
  lastActive = 0;
  iconUrl: string | null = null;
  /** Host of the page the icon belongs to. */
  private iconHost = '';
  /** Shows the new tab page of the demo until the first address loads. */
  newTab = false;
  private hideLinkStatus: (() => void) | null = null;

  constructor(view: View, init: { url?: string; title?: string; history?: SessionHistory | null }) {
    this.view = view;
    this.url = init.url ?? view.url;
    this.title = init.title ?? '';
    this.history = init.history ?? null;
    this.zoom = view.zoom;
    this.element = element('div', { className: 'tab' });
    this.element.setAttribute('role', 'tab');
    this.element.setAttribute('aria-selected', 'false');
    this.element.innerHTML =
      '<img class="icon" alt="" hidden><span class="title"></span>' +
      '<span class="recording" title="Camera, microphone or screen in use" hidden></span>' +
      '<span class="dialog-blocked" title="Dialog suppressed" hidden></span>' +
      '<button type="button" class="audio" hidden></button>' +
      '<button type="button" class="close" title="Close tab" aria-label="Close tab"></button>';
    this.part('.dialog-blocked').append(icon('blocked'));
    this.part('.close').append(icon('close'));
    this.part('.audio').addEventListener('click', () => {
      this.view.setMuted(!this.view.muted);
      this.updateAudio();
    });
    this.element.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('close') && !target.classList.contains('audio'))
        activate(this);
    });
    this.part('.close').addEventListener('click', () => requestClose(this));
    this.updateTitle();
    this.listen();
  }

  private part<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.element.querySelector(selector) as T;
  }

  /** Back/forward for the session: the pending one until the first activation. */
  get sessionHistory(): SessionHistory | null {
    return this.pending ? this.pending.history : this.history;
  }

  get isActive(): boolean {
    return active === this;
  }

  private on<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void) {
    this.view.on(type, listener);
  }

  private listen(): void {
    const view = this.view;
    this.on('navigation', (event) => {
      const label = this.label;
      const moved = event.url !== this.url;
      if (moved) {
        const entry = event.history?.entries?.[event.history.index];
        recordVisit(event.url, entry && entry.url === event.url ? entry.title : '');
      }
      const leftNewTab = this.newTab && !isBlank(event.url);
      if (leftNewTab) this.newTab = false;
      // The engine reports the icon of every page once it has loaded: until then the last one
      // stays within the site
      if (this.iconUrl && hostOf(event.url) !== this.iconHost) this.setIcon(null);
      this.url = event.url;
      this.canGoBack = event.canGoBack;
      this.canGoForward = event.canGoForward;
      this.loading = event.loading;
      if (event.history) this.history = event.history;
      // Without a title the label is the address, also a pending one
      if (this.label !== label) this.updateTitle();
      if (this.isActive) updateStar(this.url);
      this.followSiteZoom();
      persistSession();
      this.changed();
      if (this.isActive) syncHostHistory();
    });
    this.on('title', (event) => {
      this.title = event.title;
      this.updateTitle();
      // Only for the entry of the address the title belongs to
      if (!event.url || event.url === this.url) recordVisit(this.url, event.title);
      persistSession();
    });
    this.on('progress', (event) => {
      if (this.isActive) setProgress(event.value);
    });
    this.on('zoom', (event) => {
      this.zoom = event.zoom;
      this.changed();
      if (!this.zoomHost) return;
      // Like Chrome the zoom of a site applies to all its tabs
      rememberSiteZoom(this.zoomHost, event.zoom);
      for (const tab of list)
        if (tab.zoomHost === this.zoomHost && tab.view.zoom !== event.zoom)
          tab.view.setZoom(event.zoom);
    });
    this.on('commit', (event) => {
      this.errorPage = event.errorPage;
      if (this.isActive) updateSecurity(this);
      // A new document: dialogs allowed again, no user activation yet
      this.dialogsBlocked = false;
      this.updateDialogMarker();
      this.blockedPopups = [];
      if (this.isActive) updatePopupsButton(this);
      this.userActivated = false;
      updateHostBeforeUnload();
      endFind(view);
    });
    this.on('load', () => {
      this.loading = false;
      if (this.isActive) setStatus(this.notice ?? '');
      this.notice = null;
      this.changed();
    });
    this.on('error', (event) => {
      this.loading = false;
      if (this.isActive) setStatus(`Error: ${event.description}`);
      this.changed();
    });
    this.on('icon', (event) => {
      this.setIcon(event.blob);
      this.iconHost = hostOf(this.url);
      if (this.iconUrl) rememberIcon(this.url, this.iconUrl);
    });
    this.on('media-state', () => this.updateAudio());
    this.on('capture-state', (event) => {
      this.capturing = event.active;
      this.part('.recording').hidden = !event.active;
    });
    this.on('picture-in-picture', (event) => {
      this.pictureInPicture = event.active;
    });
    this.on('beforeunload-state', (event) => {
      this.hasBeforeUnload = event.hasListener;
      updateHostBeforeUnload();
    });
    this.on('user-activation', () => {
      this.userActivated = true;
      updateHostBeforeUnload();
    });
    this.on('popup-blocked', (event) => addBlockedPopup(this, event));
    // Ctrl/Cmd click or middle click on a link: a new tab in the background
    this.on('open-tab', (event) => openBackgroundTab(event.url, this));
    // mailto:, tel:, app links: the host browser hands them to the system (with its question)
    this.on('external-url', (event) => {
      window.open(event.url, '_blank', 'noopener');
      setStatus(`Opened externally: ${event.url}`);
    });
    // Files of an upload, drop or paste the page did not get
    this.on('files-skipped', (event) => {
      if (this.isActive) setStatus(skippedText(event.files));
    });
    // window.focus() or a click on a notification
    this.on('focus-request', () => {
      window.focus();
      activate(this);
    });
    // Tab past the last element of the page: to the address bar
    this.on('take-focus', () => {
      if (!this.isActive) return;
      const address = byId<HTMLInputElement>('address');
      address.focus();
      address.select();
    });
    this.on('find', (event) => showFindCount(view, event.matches, event.index));
    this.on('context-menu', (info) => {
      const items = defaultMenuItems(view, info, {
        openTab: (url) => openMenuTab(url, this),
        print: () => printTab(this),
      });
      showContextMenu(view, info, [...items, ...slotMenuItems(ui, view, info)]);
    });
    this.on('print', (event) => {
      if (this.isActive) showPreview(event.pdf, event.title);
    });
    this.on('source', (event) => {
      const page = sourcePage(event.url, event.text);
      openTab('')?.view.loadHTML(page.html, page.baseURL);
    });
    if (!debug)
      this.on('console', (event) => {
        // The prefix first: the message is text, not a format string of the host console
        console[event.level](
          `[page ${view.id}]`,
          event.message,
          ...(event.source ? [`(${event.source}:${event.line})`] : []),
        );
      });
    this.on('close', () => removeTab(this));
  }

  /**
   * Zoom per site like Chrome: a document of another host gets the zoom remembered for it. The
   * new document commits before, so its first layout may still use the zoom of the last one.
   */
  private followSiteZoom(): void {
    const host = zoomHost(this.url);
    if (host === this.zoomHost) return;
    this.zoomHost = host;
    const zoom = siteZoom(host);
    if (zoom !== this.view.zoom) this.view.setZoom(zoom);
  }

  /** Toolbar update after a change of the active tab. */
  private changed(): void {
    if (this.isActive) updateToolbar(this);
  }

  /**
   * What the address bar shows: the address a load from the browser goes to until its page
   * commits (a slow server, a sign in prompt), else the address of the page.
   */
  get address(): string {
    return this.view.pendingURL || this.url;
  }

  /** The title the tab shows: the page's, else its address, 'New tab' when blank. */
  get label(): string {
    return this.title || (isBlank(this.address) ? 'New tab' : this.address);
  }

  updateTitle(): void {
    this.part('.title').textContent = this.label;
    this.element.title = this.title;
    if (this.isActive) document.title = `${this.label} - browser-lite`;
    tabsChanged();
  }

  /** Marker at the tab: dialogs blocked or skipped in the background. */
  updateDialogMarker(): void {
    this.part('.dialog-blocked').hidden = !this.dialogsBlocked && !this.dialogSuppressed;
  }

  /** Speaker like Chrome: shows sound, a click mutes the tab. */
  updateAudio(): void {
    const button = this.part<HTMLButtonElement>('.audio');
    const { audible, muted } = this.view;
    button.hidden = !audible && !muted;
    setIcon(button, muted ? 'speaker-off' : 'speaker-on');
    button.title = muted ? 'Unmute this tab' : 'Mute this tab';
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('muted', muted);
  }

  setIcon(blob: Blob | null): void {
    if (this.iconUrl) URL.revokeObjectURL(this.iconUrl);
    this.iconUrl = blob ? URL.createObjectURL(blob) : null;
    this.showIcon();
  }

  showIcon(): void {
    const img = this.part<HTMLImageElement>('.icon');
    img.hidden = !this.iconUrl;
    if (this.iconUrl) img.src = this.iconUrl;
    else img.removeAttribute('src');
    img.onerror = () => {
      img.hidden = true;
    };
    tabsChanged();
  }

  /** @internal Shows or hides the view and the bubble of the link under the mouse. */
  show(visible: boolean): void {
    this.view.setVisible(visible);
    this.element.classList.toggle('active', visible);
    this.element.setAttribute('aria-selected', String(visible));
    this.hideLinkStatus?.();
    this.hideLinkStatus = visible ? linkStatus(this.view) : null;
  }

  /** @internal After the view closed. */
  dispose(): void {
    this.hideLinkStatus?.();
    this.hideLinkStatus = null;
    if (this.iconUrl) URL.revokeObjectURL(this.iconUrl);
    this.element.remove();
  }
}

/** The active tab, null before the first one. */
export const activeTab = (): Tab | null => active;

/** All tabs in the order of the tab strip. */
export const allTabs = (): readonly Tab[] => list;

/** The tab of a view, undefined for views without a tab. */
export const tabOf = (view: View): Tab | undefined => list.find((tab) => tab.view === view);

/** Calls listener for every new tab (also restored and discarded ones). */
export function onTabCreated(listener: (tab: Tab) => void): void {
  created.add(listener);
}

/**
 * Calls listener after a tab was added, removed, moved or activated, or its title or icon
 * changed.
 */
export function onTabsChange(listener: () => void): void {
  changeListeners.add(listener);
}

function tabsChanged(): void {
  for (const listener of changeListeners) listener();
}

/** Keyboard into the page of the active tab, or into its dialog while the page waits for one. */
export function focusPage(): void {
  if (!active || focusPrompt(active.view)) return;
  if (!active.newTab) {
    active.view.focus();
    return;
  }
  // The new tab page: the address bar like Chrome, on a phone no keyboard until a tap
  const address = byId<HTMLInputElement>('address');
  if (compactLayout()) address.blur();
  else {
    address.focus();
    address.select();
  }
}

function add(tab: Tab, before?: Tab): Tab {
  const index = before ? list.indexOf(before) : -1;
  if (index >= 0) {
    list.splice(index, 0, tab);
    before?.element.before(tab.element);
  } else {
    list.push(tab);
    byId('tab-list').append(tab.element);
  }
  for (const listener of created) listener(tab);
  tabsChanged();
  return tab;
}

/**
 * Like Chrome, a tab opened from a link of opener goes right after it; in the background after
 * the last tab opener opened before, so they keep the order of the clicks. Returns the tab to
 * insert before, undefined for the end of the strip.
 */
function linkTabPlace(opener: Tab | null, foreground: boolean): Tab | undefined {
  const at = opener ? list.indexOf(opener) : -1;
  if (at < 0) return undefined;
  const opened = foreground ? -1 : list.findLastIndex((tab) => tab.openedBy === opener);
  return list[Math.max(at, opened) + 1];
}

function createView(url?: string) {
  const browser = runtime.browser;
  if (browser?.state !== 'ready') return null;
  return browser.createView({
    container: pages(),
    visible: false,
    zoom: startSettings().zoom,
    ...(url ? { url } : {}),
  });
}

/** A new tab in the foreground with url (empty: a blank tab). */
export function openTab(url: string, newTab = false): Tab | null {
  const view = createView(url);
  if (!view) return null;
  const tab = new Tab(view, { url });
  tab.newTab = newTab;
  tab.opener = active;
  activate(add(tab));
  return tab;
}

/** A new tab in front: the home page of the settings, else the new tab page. */
export function openNewTab(): Tab | null {
  const home = settings().homePage;
  return home ? openTab(home) : openTab('', true);
}

/** Link or bookmark: in the active tab or a new one (empty url: a new tab). */
export function openURL(url: string, inNewTab: boolean): void {
  if (inNewTab || !active) {
    if (url) openTab(url);
    else openNewTab();
    return;
  }
  loadInTab(active, url);
}

/** Loads url in tab (from the address bar, the new tab page or a panel) and focuses the page. */
export function loadInTab(tab: Tab, url: string): void {
  tab.newTab = false;
  // Like Chrome after a typed address: the next tabs from links go next to their opener again
  for (const other of list) other.openedBy = null;
  tab.view.load(url);
  // The address shows right away (pending until the page commits)
  tab.updateTitle();
  if (tab.isActive) updateToolbar(tab);
  focusPage();
}

/** A new tab in the background from a link of opener (Ctrl click), placed after it. */
export function openBackgroundTab(url: string, opener: Tab | null): Tab | null {
  const view = createView(url);
  if (!view) return null;
  const tab = new Tab(view, { url });
  tab.openedBy = opener;
  add(tab, linkTabPlace(opener, false));
  persistSession();
  return tab;
}

/**
 * Open link or image in new tab of the context menu: in the background like Chrome. The phone
 * layout shows no tab strip, so like Chrome on Android a message offers to switch to it.
 */
function openMenuTab(url: string, opener: Tab): void {
  const tab = openBackgroundTab(url, opener);
  if (tab && compactLayout())
    showSnackbar('Opened in a new tab', { label: 'Switch', run: () => activate(tab) });
}

/** Tab of the session that loads only on the first click; `before` keeps its place. */
export function restoredTab(entry: Omit<SessionEntry, 'active'>, before?: Tab): Tab | null {
  const view = createView();
  if (!view) return null;
  const tab = new Tab(view, { url: entry.url, title: entry.title, history: entry.history ?? null });
  tab.pending = {
    url: entry.url,
    history: entry.history?.entries?.length ? entry.history : null,
  };
  return add(tab, before);
}

const skipReasons: Record<SkippedFile['reason'], string> = {
  'too-large': 'larger than 512 MB',
  unreadable: 'could not be read',
};

function skippedText(files: SkippedFile[]): string {
  const [first] = files;
  if (files.length === 1 && first)
    return `Not uploaded: ${first.name} (${skipReasons[first.reason]})`;
  return `${files.length} files not uploaded: ${files.map((file) => `${file.name} (${skipReasons[file.reason]})`).join(', ')}`;
}

/**
 * A view the engine opened (window.open, target=_blank) becomes the active tab, right after the
 * tab of opener (without one the active tab).
 */
export function adoptView(view: View, opener: View | null): void {
  view.attach(pages());
  if (view.zoom !== startSettings().zoom) view.setZoom(startSettings().zoom);
  const tab = new Tab(view, {});
  tab.opener = active;
  tab.openedBy = (opener && tabOf(opener)) ?? active;
  activate(add(tab, linkTabPlace(tab.openedBy, true)));
}

export function activate(tab: Tab): void {
  if (active === tab || tab.view.closed) return;
  const now = Date.now();
  tab.lastActive = now;
  if (active) {
    active.lastActive = now;
    active.opener = null;
    active.show(false);
  }
  active = tab;
  tab.dialogSuppressed = false;
  tab.updateDialogMarker();
  updateStar(tab.url);
  if (tab.pending) {
    // With back/forward like before the restart or the discard
    const { url, history } = tab.pending;
    tab.pending = null;
    if (history) tab.view.restoreHistory(history);
    else tab.view.load(url);
  }
  persistSession();
  tab.show(true);
  showPromptsOf(tab.view);
  showFindOf(tab.view);
  // The address bar shows the address of this tab
  const address = byId('address');
  if (document.activeElement === address) address.blur();
  updateToolbar(tab);
  syncHostHistory();
  tab.updateTitle();
  focusPage();
}

/** Moves tab to index of the strip (clamped to its ends), like dragging it in Chrome. */
export function moveTab(tab: Tab, index: number): void {
  const from = list.indexOf(tab);
  const to = Math.max(0, Math.min(index, list.length - 1));
  if (from < 0 || to === from) return;
  list.splice(from, 1);
  list.splice(to, 0, tab);
  const next = list[to + 1];
  if (next) next.element.before(tab.element);
  else byId('tab-list').append(tab.element);
  persistSession();
  tabsChanged();
}

/** Next (offset 1) or previous (-1) tab, wrapping around. */
export function switchTab(offset: number): void {
  if (list.length < 2 || !active) return;
  const index = list.indexOf(active);
  const next = list[(index + offset + list.length) % list.length];
  if (next) activate(next);
}

/**
 * Closing by the user: a page with a beforeunload listener may ask first. Like Chrome the tab
 * comes to the front only when a question can come (WebCore asks only after a user action);
 * afterwards the tab before becomes active again.
 */
export function requestClose(tab: Tab): void {
  if (tab.closing) return;
  if (tab.hasBeforeUnload) {
    tab.closing = true;
    tab.closeReturn = active !== tab ? active : null;
    if (tab.userActivated) activate(tab);
  }
  void tab.view.close().then(() => {
    tab.closing = false;
    tab.closeReturn = null;
  });
}

// The view closed (by the user, window.close() or a discard)
function removeTab(tab: Tab): void {
  const index = list.indexOf(tab);
  if (index < 0) return;
  list.splice(index, 1);
  for (const other of list) if (other.openedBy === tab) other.openedBy = null;
  tab.dispose();
  tabsChanged();
  if (runtime.stopped) return;
  if (!tab.replaced && !isInternal(tab.url)) rememberClosed({ entry: sessionEntry(tab), index });
  setTimeout(persistSession);
  updateHostBeforeUnload();
  if (active !== tab) return;
  active = null;
  // Like Chrome and Firefox: back to the tab it came from, else the right neighbour, else the left
  const next =
    [tab.closeReturn, tab.opener].find((back) => back && list.includes(back)) ??
    list[index] ??
    list[index - 1];
  if (next) activate(next);
  else openNewTab();
}

/**
 * Ctrl+Shift+T like Chrome: the tab closed last comes back in front at its place, with back and
 * forward. Nothing happens when no closed tab is left.
 */
export function reopenClosedTab(): void {
  const closed = takeClosed();
  if (!closed) return;
  const tab = restoredTab(closed.entry, list[closed.index]);
  if (tab) activate(tab);
}

// A background tab whose page takes memory: not one that loads on the next click, not an empty
// new tab
function holdsPage(tab: Tab): boolean {
  return tab !== active && !tab.pending && !tab.newTab;
}

/** Whether closing a background tab frees memory: one of them holds a page. */
export function backgroundPageLoaded(): boolean {
  return list.some(holdsPage);
}

/**
 * Like Chrome with little memory: all tabs share the memory of the engine. On 'memory-pressure'
 * the background tab unused for the longest time becomes one that loads on the next click.
 * Tabs with sound or camera/microphone stay; tabs with a picture-in-picture window or input
 * the page would ask about when leaving come last. Returns the new tab, null when none fits.
 */
export function discardForMemory(): Tab | null {
  const candidates = list.filter(
    (tab) =>
      holdsPage(tab) &&
      !tab.view.audible &&
      !tab.capturing &&
      /^(https?|file):/.test(tab.url || ''),
  );
  const kept = (tab: Tab) =>
    tab.pictureInPicture || (tab.hasBeforeUnload && tab.userActivated) ? 1 : 0;
  candidates.sort((a, b) => kept(a) - kept(b) || a.lastActive - b.lastActive);
  const tab = candidates[0];
  if (!tab) return null;
  const fresh = restoredTab(
    { url: tab.url, title: tab.title, history: tab.history ?? undefined },
    tab,
  );
  if (!fresh) return null;
  fresh.lastActive = tab.lastActive;
  fresh.openedBy = tab.openedBy;
  for (const other of list) if (other.openedBy === tab) other.openedBy = fresh;
  // The icon now belongs to the new tab
  fresh.iconUrl = tab.iconUrl;
  tab.iconUrl = null;
  fresh.showIcon();
  tab.replaced = true;
  void tab.view.close({ force: true });
  return fresh;
}

/** Saves the session, but not after a crash: the last good state stays for the restart. */
export function persistSession(): void {
  if (!runtime.stopped && runtime.browser?.state === 'ready') saveSession(list, active);
}

/**
 * The host asks when closing or reloading the demo only while a tab has a beforeunload listener
 * and a user action in its document; the handler of the page cannot be asked from here.
 */
function updateHostBeforeUnload(): void {
  const ask = list.some((tab) => tab.hasBeforeUnload && tab.userActivated);
  window.onbeforeunload = ask
    ? (e) => {
        if (runtime.browser?.state === 'ready' && !uiReloading()) e.preventDefault();
      }
    : null;
}

/** Builds the PDF of the tab; the preview follows with the 'print' event. */
export function printTab(tab: Tab | null): void {
  if (!tab) return;
  printing();
  tab.view.print();
}

/** Removes all tabs from the strip (the views are gone with their browser). */
export function clearTabs(): void {
  for (const tab of list.splice(0)) tab.dispose();
  active = null;
  tabsChanged();
  syncHostHistory();
  window.onbeforeunload = null;
}
