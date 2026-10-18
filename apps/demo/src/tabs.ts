import type { SessionHistory, View, ViewEvents } from '@browser-lite/core';
import { defaultMenuItems, linkStatus, showContextMenu } from '@browser-lite/ui';
import { showFindCount } from './find-bar.js';
import { recordVisit } from './history.js';
import { debug } from './params.js';
import { printing, showPreview } from './print-preview.js';
import { uiReloading } from './reload.js';
import { runtime } from './runtime.js';
import { type SessionEntry, type SessionTab, saveSession } from './session.js';
import { settings, startSettings } from './settings.js';
import { setProgress, setStatus, updateSecurity, updateStar, updateToolbar } from './toolbar.js';
import { byId, element } from './util.js';
import { sourcePage } from './view-source.js';

const list: Tab[] = [];
let active: Tab | null = null;
const created = new Set<(tab: Tab) => void>();

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
  /** Dialogs of the current document blocked by the user, or skipped in the background. */
  dialogsBlocked = false;
  dialogSuppressed = false;
  lastActive = 0;
  iconUrl: string | null = null;
  private hideLinkStatus: (() => void) | null = null;

  constructor(view: View, init: { url?: string; title?: string; history?: SessionHistory | null }) {
    this.view = view;
    this.url = init.url ?? view.url;
    this.title = init.title ?? '';
    this.history = init.history ?? null;
    this.zoom = view.zoom;
    this.element = element('div', { className: 'tab' });
    this.element.innerHTML =
      '<img class="icon" alt="" hidden><span class="title"></span>' +
      '<span class="recording" title="Camera, microphone or screen in use" hidden>&#9679;</span>' +
      '<span class="dialog-blocked" title="Dialog suppressed" hidden>&#8856;</span>' +
      '<button class="audio" hidden></button><button class="close" title="Close tab">&#215;</button>';
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
      if (event.url !== this.url) {
        const entry = event.history?.entries?.[event.history.index];
        recordVisit(event.url, entry && entry.url === event.url ? entry.title : '');
      }
      this.url = event.url;
      this.canGoBack = event.canGoBack;
      this.canGoForward = event.canGoForward;
      this.loading = event.loading;
      if (event.history) this.history = event.history;
      if (this.isActive) updateStar(this.url);
      persistSession();
      this.changed();
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
    });
    this.on('commit', (event) => {
      this.errorPage = event.errorPage;
      if (this.isActive) updateSecurity(this);
      // A new document: dialogs allowed again, no user activation yet
      this.dialogsBlocked = false;
      this.updateDialogMarker();
      this.userActivated = false;
      updateHostBeforeUnload();
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
    this.on('icon', (event) => this.setIcon(event.blob));
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
    // Ctrl/Cmd click or middle click on a link: a new tab in the background
    this.on('open-tab', (event) => openBackgroundTab(event.url));
    // mailto:, tel:, app links: the host browser hands them to the system (with its question)
    this.on('external-url', (event) => {
      window.open(event.url, '_blank', 'noopener');
      setStatus(`Opened externally: ${event.url}`);
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
    this.on('find', (event) => {
      if (this.isActive) showFindCount(event.matches, event.index);
    });
    this.on('context-menu', (info) => {
      const items = defaultMenuItems(view, info, {
        openTab: (url) => openTab(url),
        print: () => printTab(this),
      });
      showContextMenu(view, info, items);
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
        console[event.level](
          `[page ${view.id}] ${event.message}`,
          event.source ? `(${event.source}:${event.line})` : '',
        );
      });
    this.on('close', () => removeTab(this));
  }

  /** Toolbar update after a change of the active tab. */
  private changed(): void {
    if (this.isActive) updateToolbar(this);
  }

  updateTitle(): void {
    this.part('.title').textContent = this.title || this.url || 'New tab';
    this.element.title = this.title;
    if (this.isActive) document.title = `${this.title ? `${this.title} - ` : ''}browser-lite`;
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
    button.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    button.title = muted ? 'Unmute this tab' : 'Mute this tab';
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
  }

  /** @internal Shows or hides the view and the bubble of the link under the mouse. */
  show(visible: boolean): void {
    this.view.setVisible(visible);
    this.element.classList.toggle('active', visible);
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

/** Keyboard into the page of the active tab. */
export function focusPage(): void {
  active?.view.focus();
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
  return tab;
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
export function openTab(url: string): Tab | null {
  const view = createView(url);
  if (!view) return null;
  const tab = add(new Tab(view, { url }));
  activate(tab);
  return tab;
}

/** Link or bookmark: in the active tab or a new one (empty url: home page). */
export function openURL(url: string, inNewTab: boolean): void {
  if (inNewTab || !active) {
    openTab(url || settings().homePage || 'about:blank');
    if (!url) byId('address').focus();
    return;
  }
  active.view.load(url);
  focusPage();
}

/** A new tab in the background (Ctrl click on a link). */
export function openBackgroundTab(url: string): Tab | null {
  const view = createView(url);
  if (!view) return null;
  const tab = add(new Tab(view, { url }));
  persistSession();
  return tab;
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

/** A view the engine opened (window.open, target=_blank) becomes the active tab. */
export function adoptView(view: View): void {
  view.attach(pages());
  if (view.zoom !== startSettings().zoom) view.setZoom(startSettings().zoom);
  activate(add(new Tab(view, {})));
}

export function activate(tab: Tab): void {
  if (active === tab || tab.view.closed) return;
  const now = Date.now();
  tab.lastActive = now;
  if (active) {
    active.lastActive = now;
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
  focusPage();
  updateToolbar(tab);
  tab.updateTitle();
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
  tab.dispose();
  if (runtime.stopped) return;
  setTimeout(persistSession);
  updateHostBeforeUnload();
  if (active !== tab) return;
  active = null;
  const back = tab.closeReturn;
  const next = back && list.includes(back) ? back : list.at(-1);
  if (next) activate(next);
  else openTab('about:blank');
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
      tab !== active &&
      !tab.pending &&
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
  // The icon now belongs to the new tab
  fresh.iconUrl = tab.iconUrl;
  tab.iconUrl = null;
  fresh.showIcon();
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
  window.onbeforeunload = null;
}
