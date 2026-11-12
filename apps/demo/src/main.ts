import {
  type Browser,
  BrowserLiteError,
  type BrowserOptions,
  checkSupport,
  createBrowser,
  defaultServices,
  webrtc,
} from '@browser-lite/core';
import { type WispErrorEvent, WispTransport } from '@browser-lite/transport-wisp';
import {
  colorPicker,
  dataListPopup,
  dateTimePicker,
  fileChooser,
  loginPrompt,
  permissionPrompt,
  renderToolbar,
  selectPopup,
} from '@browser-lite/ui';
import { askForAccessCode } from './access.js';
import { addressToLoad, takePendingAddress } from './address-bar.js';
import { hideBarWhileScrolling } from './bar-hiding.js';
import { initBlockedPopups } from './blocked-popups.js';
import { onBookmarksChange, toggleBookmark } from './bookmarks.js';
import { dialogHandler } from './dialogs.js';
import { addDownload } from './downloads.js';
import { hideMessage, showMessage, showStartProgress } from './engine-message.js';
import { builtInExtensions, extensions, ui } from './extensions.js';
import { initFindBar, openFind } from './find-bar.js';
import { onHistoryClear, readHistory } from './history.js';
import { initHistoryMenu } from './history-menu.js';
import { followHostHistory } from './host-history.js';
import { renderIcons } from './icons.js';
import { initNewTabPage } from './new-tab-page.js';
import { keepPageSizeWhileEditing } from './page-size.js';
import { debug, engineOptions, relayUrl, startUrl, tokenFor } from './params.js';
import { profilePermissions } from './permissions.js';
import { onPreviewClosed } from './print-preview.js';
import { followShownView } from './prompts.js';
import {
  addressWithoutUrl,
  markRestart,
  reloadUI,
  takeRestart,
  watchUnexpectedEnd,
} from './reload.js';
import { followRotation } from './rotation.js';
import { profile, runtime } from './runtime.js';
import { sessionToRestore } from './session.js';
import { needsNewEngine, type StartSettings, updateStartSettings } from './settings.js';
import { openSettings } from './settings-page.js';
import { installShortcuts } from './shortcuts.js';
import { initSidePanel, panelOpen, togglePanel } from './side-panel.js';
import { initTabDrag } from './tab-drag.js';
import { initTabMenu } from './tab-menu.js';
import { initTabOverview } from './tab-overview.js';
import {
  activate,
  activeTab,
  adoptView,
  backgroundPageLoaded,
  clearTabs,
  discardForMemory,
  downloadStarted,
  focusPage,
  openNewTab,
  openTab,
  openURL,
  printTab,
  restoredTab,
  type Tab,
} from './tabs.js';
import { installTestHooks, type TestState, withTestOptions } from './test-hooks.js';
import { setStatus, updateStar } from './toolbar.js';
import { byId, storage } from './util.js';
import { fitVisualViewport } from './visual-viewport.js';
import { changeZoom } from './zoom.js';

const DEFAULT_URL = 'https://example.com/';
// A crash this soon after the last one restarts with tabs that load only when clicked
// (otherwise the same page crashes again)
const REPEAT_WINDOW = 60000;
const CRASH_KEY = 'bl-crash-time';
const SAFE_START_KEY = 'bl-safe-start';
// Memory critical and no background tab left to discard, but loaded ones that stay (sound,
// camera); without them closing tabs frees nothing (discarded tabs hold no page)
const MEMORY_FULL = 'Memory is almost full: close tabs, or the browser may crash and restart';
const MEMORY_FULL_PAGE =
  'Memory is almost full: this page uses most of it, the browser may crash and restart';

const testState: TestState = { transport: null, options: null };
/** Relay connection of the running browser: a restart closes it and opens a new one. */
let transport: WispTransport | null = null;

/** Status line text, also after the next load of the active tab. */
function showNotice(text: string): void {
  const tab = activeTab();
  if (tab) tab.notice = text;
  setStatus(text);
}

/**
 * Emulated mobile device: the page area as large as its screen, at most as large as the space.
 * The device the host is keeps the whole window.
 */
function emulateDevice(start: StartSettings): void {
  const viewport = byId('viewport');
  const frame = start.frame;
  viewport.classList.toggle('device', !!frame);
  if (!frame) return;
  viewport.style.setProperty('--device-width', `${frame.width}px`);
  viewport.style.setProperty('--device-height', `${frame.height}px`);
}

/** `openProfile`: download the profile into the storage directory before the engine starts. */
function browserOptions(
  start: StartSettings,
  transport: WispTransport,
  openProfile: boolean,
): BrowserOptions {
  const options: BrowserOptions = {
    engineUrl: new URL(import.meta.env.VITE_ENGINE_BASE || 'engine/', location.href),
    transport,
    storage: openProfile ? { beforeStart: profile.beforeStart } : {},
    serviceWorker: { url: new URL('sw.js', location.href) },
    // WebRTC of the pages goes through the host browser (not the relay), like in Chrome
    services: [...defaultServices(), webrtc()],
    handlers: {
      ...selectPopup(),
      ...dataListPopup(),
      ...colorPicker(),
      ...dateTimePicker(),
      ...fileChooser(),
      ...permissionPrompt(),
      ...loginPrompt(),
      ...dialogHandler(),
    },
    permissions: profilePermissions,
    extensions,
    ...start.options,
    engine: engineOptions(),
    onProgress: showStartProgress,
    debug,
  };
  return debug ? withTestOptions(options) : options;
}

/** The tabs at the start: the last session (unless ?url=) or the start page. */
function openStartTabs(restarted: boolean): void {
  // An address typed while the engine started opens in front of a restored session
  const typed = takePendingAddress();
  const url = typed || (restarted || !startUrl ? null : addressToLoad(startUrl));
  const safe = !!storage(SAFE_START_KEY, undefined, true);
  storage(SAFE_START_KEY, null, true);
  const session = url && !typed ? null : sessionToRestore();
  if (!session) {
    openTab(url || DEFAULT_URL);
    return;
  }
  const restored = session.map((entry) => restoredTab(entry));
  if (safe) {
    if (typed) openTab(typed);
    else openNewTab();
    showNotice('After the restart the tabs load only when clicked');
    return;
  }
  if (typed) {
    openTab(typed);
    return;
  }
  const index = session.findIndex((entry) => entry.active);
  const tab = restored[Math.max(0, index)];
  if (tab) activate(tab);
  else openTab(DEFAULT_URL);
}

function closeTransport(): void {
  transport?.close();
  transport = null;
}

function showHang(): void {
  showMessage(
    'The page is not responding.',
    ['A script blocks the engine and with it all tabs. Unless you wait, the engine stops it.'],
    [
      [
        'Wait',
        () => {
          hideMessage();
          // The script gets the engine's whole limit again, the question comes again if the
          // engine still does not answer
          runtime.browser?.keepWaiting();
        },
      ],
      ['Restart', () => void restart(true)],
    ],
  );
}

function crashed(reason: string): void {
  runtime.stopped = true;
  const now = Date.now();
  const repeated = now - (Number(storage(CRASH_KEY, undefined, true)) || 0) < REPEAT_WINDOW;
  storage(CRASH_KEY, String(now), true);
  // The reason can carry the whole stack of the engine: only its first line on the card, the
  // rest in the console
  console.error(`Engine crash: ${reason}`);
  const summary = reason.split('\n')[0] ?? '';
  showMessage(
    'The engine crashed.',
    [
      repeated
        ? 'It crashed again soon after the last crash: after the restart the tabs load only when clicked.'
        : 'After the restart all tabs are back.',
      summary.length > 160 ? `${summary.slice(0, 160)}…` : summary,
    ],
    [['Restart', () => void restart(repeated)]],
  );
}

/**
 * The host browser ended the last page of this tab (iOS ends the whole page when it runs out of
 * memory, then Safari loads it again): like after an engine crash the start keeps the session,
 * without the tab of `?url=`, and a second end within a minute starts safe.
 */
function pageEndedUnexpectedly(): void {
  const now = Date.now();
  const repeated = now - (Number(storage(CRASH_KEY, undefined, true)) || 0) < REPEAT_WINDOW;
  storage(CRASH_KEY, String(now), true);
  if (repeated) storage(SAFE_START_KEY, '1', true);
  markRestart();
  history.replaceState(history.state, '', addressWithoutUrl());
}

/**
 * One engine runs all tabs: after a crash or hang a new browser starts in this page with the
 * last saved session (safe: the tabs load only when clicked). Reloads the page when the old
 * engine cannot be stopped.
 */
async function restart(safe: boolean): Promise<void> {
  if (safe) storage(SAFE_START_KEY, '1', true);
  markRestart();
  history.replaceState(history.state, '', addressWithoutUrl());
  runtime.stopped = true;
  const browser = runtime.browser;
  runtime.browser = null;
  showMessage('Restarting…');
  await browser?.destroy().catch((error: unknown) => console.warn('destroy:', error));
  closeTransport();
  clearTabs();
  // A page in fullscreen belonged to the old engine
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  await start(true);
}

/** Creates the browser with its own transport; null after an error (shown or reloading). */
async function launch(
  settings: StartSettings,
  restarted: boolean,
  openProfile: boolean,
): Promise<Browser | null> {
  const token = tokenFor(relayUrl.host);
  transport = new WispTransport({ url: relayUrl, ...(token ? { token } : {}) });
  // A missing or old token is no lost connection: ask for the access code
  transport.addEventListener('error', (event) => {
    if ((event as WispErrorEvent).reason === 'unauthorized') askForAccessCode();
  });
  testState.transport = transport;
  const options = browserOptions(settings, transport, openProfile);
  testState.options = options;
  try {
    return await createBrowser(options);
  } catch (error) {
    closeTransport();
    // An engine that could not be stopped keeps running: only a reload helps
    if (restarted && error instanceof BrowserLiteError && error.code === 'already-running') {
      reloadUI(addressWithoutUrl());
      return null;
    }
    console.error(error);
    showMessage(`Error at start: ${(error as Error).message}`);
    return null;
  }
}

/** Applies what changed from `running` to `next` and the engine takes without a new start. */
function applyChanges(browser: Browser, running: StartSettings, next: StartSettings): void {
  const changed = (...keys: (keyof StartSettings['options'])[]) =>
    keys.some((key) => JSON.stringify(running.options[key]) !== JSON.stringify(next.options[key]));
  const { options } = next;
  if (changed('userAgent', 'platform')) browser.setUserAgent(options.userAgent, options.platform);
  if (changed('languages')) browser.setLanguages(options.languages);
  if (changed('colorScheme')) browser.setColorScheme(options.colorScheme);
  if (changed('preferences')) browser.setPreferences(options.preferences);
  if (changed('maxPixelRatio')) browser.setMaxPixelRatio(options.maxPixelRatio ?? null);
}

async function start(restarted: boolean): Promise<void> {
  const support = checkSupport();
  if (!support.supported) {
    showMessage('This browser cannot run browser-lite.', [
      `Missing: ${support.missing.join(', ')}`,
    ]);
    return;
  }
  // "Restart now" and the restart after a crash always keep the session
  const keepSession = takeRestart();
  // The prefs of the last start on this device: the profile of the server only arrives in
  // storage.beforeStart, after the options of the engine are fixed
  const cached = updateStartSettings(keepSession);
  // Their scripts reach the first page
  await builtInExtensions;
  let browser = await launch(cached, restarted, true);
  if (!browser) return;
  const settings = updateStartSettings(keepSession);
  if (needsNewEngine(cached, settings)) {
    // The profile is already in the storage directory
    await browser.destroy().catch((error: unknown) => console.warn('destroy:', error));
    closeTransport();
    browser = await launch(settings, true, false);
    if (!browser) return;
  } else {
    applyChanges(browser, cached, settings);
  }
  emulateDevice(settings);
  runtime.browser = browser;
  runtime.stopped = false;
  // :visited of the pages from the history of this device
  browser.addVisitedLinks(readHistory().map((visit) => visit.url));
  profile.attach(browser);
  browser.on('new-view', ({ view, opener }) => adoptView(view, opener));
  browser.on('download', ({ download }) => {
    addDownload(download);
    downloadStarted(download.view);
  });
  // 'moderate' (above the engine's budget) only discards; the notice only when memory is short
  browser.on('memory-pressure', ({ level }) => {
    if (discardForMemory() || level !== 'critical') return;
    showNotice(backgroundPageLoaded() ? MEMORY_FULL : MEMORY_FULL_PAGE);
  });
  browser.on('crash', ({ reason }) => crashed(reason));
  browser.on('unresponsive', () => showHang());
  browser.on('responsive', () => {
    if (!runtime.stopped) hideMessage();
  });
  browser.on('warning', ({ code }) => {
    if (code === 'storage-locked')
      showNotice('browser-lite is already open in another tab, nothing is saved here');
  });
  hideMessage();
  openStartTabs(restarted);
  if (profile.status === 'local') showNotice(profile.statusText);
}

onHistoryClear(() => runtime.browser?.clearVisitedLinks());

// The profile was opened or reset on another device: nothing is saved here any more
profile.on('status', () => {
  if (profile.status !== 'taken' && profile.status !== 'reset') return;
  const notice = byId('profile-notice');
  const text = notice.querySelector('span');
  if (text) text.textContent = profile.statusText;
  notice.querySelector('button')?.addEventListener('click', () => reloadUI(), { once: true });
  notice.hidden = false;
});

initSidePanel({
  openURL,
  download: (url) => activeTab()?.view.download(url),
  find: openFind,
  print: () => printTab(activeTab()),
  openSettings: (section) => openSettings(section),
});
initFindBar({ view: () => activeTab()?.view ?? null, focusPage });
followHostHistory(() => {
  const tab = activeTab();
  return (
    tab && {
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      back: () => tab.view.back(),
      forward: () => tab.view.forward(),
    }
  );
});
initBlockedPopups((url) => openURL(url, true));
initTabOverview();
initTabDrag();
initTabMenu();
initHistoryMenu();
initNewTabPage();
followShownView([document.body, byId('pages')]);
onPreviewClosed(focusPage);
onBookmarksChange(() => {
  const tab = activeTab();
  if (tab) updateStar(tab.url);
});
installShortcuts();
fitVisualViewport();
keepPageSizeWhileEditing(byId('pages'));
followRotation();
hideBarWhileScrolling();
renderIcons();
// Where the chrome ends (side panel and menu start there) and how high it is (the sheets of the
// phone layout sit on its bar at the bottom)
new ResizeObserver(() => {
  const rect = byId('chrome').getBoundingClientRect();
  const root = document.documentElement.style;
  root.setProperty('--chrome-bottom', `${rect.bottom}px`);
  root.setProperty('--chrome-height', `${rect.height}px`);
}).observe(byId('chrome'));
renderToolbar(ui, byId('extension-buttons'), () => activeTab()?.view ?? null);
if (debug) installTestHooks(testState);

/**
 * A toolbar button that acts on the page. Like Chrome a press with the mouse or a finger takes no
 * focus and the page has the keyboard after the action, so Space and the arrow keys scroll it
 * instead of pressing the button again; a button reached with Tab keeps the focus.
 */
function pageButton(id: string, action: (tab: Tab) => void): void {
  const button = byId(id);
  button.addEventListener('mousedown', (e) => {
    if (e.button === 0) e.preventDefault();
  });
  button.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    action(tab);
    if (document.activeElement !== button) focusPage();
  });
}

pageButton('back', (tab) => tab.view.back());
pageButton('forward', (tab) => tab.view.forward());
pageButton('reload', (tab) => (tab.loading ? tab.view.stop() : tab.view.reload()));
byId('new-tab').addEventListener('click', () => openURL('', true));
byId('bookmark').addEventListener('click', () => {
  const tab = activeTab();
  if (tab) toggleBookmark(tab.url, tab.title);
});
byId('zoom').addEventListener('click', () => {
  const tab = activeTab();
  if (tab) changeZoom(tab.view, 0);
});
byId('menu-button').addEventListener('click', (e) => {
  togglePanel(panelOpen() ? null : 'menu');
  // Opened with the keyboard: into the menu, the arrow keys move on
  if (e.detail === 0 && panelOpen())
    byId('side-panel').querySelector<HTMLElement>('.panel-menu-item')?.focus();
});

// Back from the back-forward cache: the core ended the engine when the page was hidden
addEventListener('pageshow', (event) => {
  if (event.persisted) void restart(false);
});

const endedUnexpectedly = watchUnexpectedEnd();
if (endedUnexpectedly) pageEndedUnexpectedly();
void start(endedUnexpectedly);
