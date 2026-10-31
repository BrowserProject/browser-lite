import {
  type Browser,
  BrowserLiteError,
  type BrowserOptions,
  checkSupport,
  createBrowser,
  defaultServices,
  webrtc,
} from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';
import {
  colorPicker,
  dateTimePicker,
  fileChooser,
  loginPrompt,
  permissionPrompt,
  renderToolbar,
  selectPopup,
} from '@browser-lite/ui';
import { takePendingAddress } from './address-bar.js';
import { onBookmarksChange, toggleBookmark } from './bookmarks.js';
import { dialogHandler } from './dialogs.js';
import { addDownload } from './downloads.js';
import { hideMessage, showMessage, showStartProgress } from './engine-message.js';
import { builtInExtensions, extensions, ui } from './extensions.js';
import { initFindBar, openFind } from './find-bar.js';
import { debug, engineOptions, relayUrl, startUrl, tokenFor } from './params.js';
import { profilePermissions } from './permissions.js';
import { onPreviewClosed } from './print-preview.js';
import { addressWithoutUrl, markRestart, reloadUI, takeRestart } from './reload.js';
import { profile, runtime } from './runtime.js';
import { sessionToRestore } from './session.js';
import { needsNewEngine, type StartSettings, updateStartSettings } from './settings.js';
import { openSettings } from './settings-page.js';
import { installShortcuts } from './shortcuts.js';
import { initSidePanel, panelOpen, togglePanel } from './side-panel.js';
import { initTabOverview } from './tab-overview.js';
import {
  activate,
  activeTab,
  adoptView,
  clearTabs,
  discardForMemory,
  focusPage,
  openTab,
  openURL,
  printTab,
  restoredTab,
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
// Memory pressure and no background tab left to discard
const MEMORY_FULL = 'Memory is almost full: close tabs, or the browser may crash and restart';
// After "Wait" the hang message comes back while the engine still does not answer
const HANG_REPEAT = 10000;

const testState: TestState = { transport: null, options: null };
/** Relay connection of the running browser: a restart closes it and opens a new one. */
let transport: WispTransport | null = null;
let hung = false;
let hangTimer = 0;

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
  const url = typed || (restarted ? null : startUrl);
  const safe = !!storage(SAFE_START_KEY, undefined, true);
  storage(SAFE_START_KEY, null, true);
  const session = url && !typed ? null : sessionToRestore();
  if (!session) {
    openTab(url || DEFAULT_URL);
    return;
  }
  const restored = session.map((entry) => restoredTab(entry));
  if (safe) {
    openTab(typed || 'about:blank');
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
    ['A script blocks the engine and with it all tabs. If it runs too long, the engine stops it.'],
    [
      [
        'Wait',
        () => {
          hideMessage();
          clearTimeout(hangTimer);
          hangTimer = window.setTimeout(() => {
            if (hung && !runtime.stopped) showHang();
          }, HANG_REPEAT);
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
  showMessage(
    'The engine crashed.',
    [
      repeated
        ? 'It crashed again soon after the last crash: after the restart the tabs load only when clicked.'
        : 'After the restart all tabs are back.',
      reason,
    ],
    [['Restart', () => void restart(repeated)]],
  );
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
  hung = false;
  clearTimeout(hangTimer);
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
  profile.attach(browser);
  browser.on('new-view', ({ view }) => adoptView(view));
  browser.on('download', ({ download }) => addDownload(download));
  browser.on('memory-pressure', () => {
    if (!discardForMemory()) showNotice(MEMORY_FULL);
  });
  browser.on('crash', ({ reason }) => crashed(reason));
  browser.on('unresponsive', () => {
    hung = true;
    showHang();
  });
  browser.on('responsive', () => {
    hung = false;
    clearTimeout(hangTimer);
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
  find: openFind,
  print: () => printTab(activeTab()),
  openSettings: () => openSettings(),
});
initFindBar({ view: () => activeTab()?.view ?? null, focusPage });
initTabOverview();
onPreviewClosed(focusPage);
onBookmarksChange(() => {
  const tab = activeTab();
  if (tab) updateStar(tab.url);
});
installShortcuts();
fitVisualViewport();
renderToolbar(ui, byId('extension-buttons'), () => activeTab()?.view ?? null);
if (debug) installTestHooks(testState);

byId('back').addEventListener('click', () => activeTab()?.view.back());
byId('forward').addEventListener('click', () => activeTab()?.view.forward());
byId('reload').addEventListener('click', () => {
  const tab = activeTab();
  if (tab?.loading) tab.view.stop();
  else tab?.view.reload();
});
byId('new-tab').addEventListener('click', () => openURL('', true));
byId('bookmark').addEventListener('click', () => {
  const tab = activeTab();
  if (tab) toggleBookmark(tab.url, tab.title);
});
byId('zoom').addEventListener('click', () => {
  const tab = activeTab();
  if (tab) changeZoom(tab.view, 0);
});
byId('clear-data').addEventListener('click', () => {
  togglePanel(null);
  openSettings('profile');
});
byId('menu-button').addEventListener('click', () => togglePanel(panelOpen() ? null : 'menu'));

void start(false);
