import {
  BrowserLiteError,
  type BrowserOptions,
  checkSupport,
  createBrowser,
  defaultServices,
  webrtc,
} from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';
import { colorPicker, dateTimePicker, permissionPrompt, selectPopup } from '@browser-lite/ui';
import { onBookmarksChange, toggleBookmark } from './bookmarks.js';
import { dialogHandler } from './dialogs.js';
import { addDownload } from './downloads.js';
import { hideMessage, showMessage } from './engine-message.js';
import { initFindBar, openFind } from './find-bar.js';
import { debug, engineOptions, relayUrl, startUrl, tokenFor } from './params.js';
import { profilePermissions } from './permissions.js';
import { onPreviewClosed } from './print-preview.js';
import { addressWithoutUrl, markRestart, reloadUI } from './reload.js';
import { profile, runtime } from './runtime.js';
import { sessionToRestore } from './session.js';
import { resetStartSettings, type StartSettings, startSettings } from './settings.js';
import { openSettings } from './settings-page.js';
import { installShortcuts } from './shortcuts.js';
import { initSidePanel, panelOpen, togglePanel } from './side-panel.js';
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
import { changeZoom } from './zoom.js';

const DEFAULT_URL = 'https://example.com/';
// A crash this soon after the last one restarts with tabs that load only when clicked
// (otherwise the same page crashes again)
const REPEAT_WINDOW = 60000;
const CRASH_KEY = 'bl-crash-time';
const SAFE_START_KEY = 'bl-safe-start';
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

/** Mobile device: the page area as large as its screen, at most as large as the space. */
function emulateDevice(start: StartSettings): void {
  const viewport = byId('viewport');
  const screen = start.device.screen;
  viewport.classList.toggle('device', !!screen);
  if (!screen) return;
  viewport.style.setProperty('--device-width', `${screen.width}px`);
  viewport.style.setProperty('--device-height', `${screen.height}px`);
}

function browserOptions(start: StartSettings, transport: WispTransport): BrowserOptions {
  const options: BrowserOptions = {
    engineUrl: new URL(import.meta.env.VITE_ENGINE_BASE || 'engine/', location.href),
    transport,
    storage: { beforeStart: profile.beforeStart },
    serviceWorker: { url: new URL('sw.js', location.href) },
    // WebRTC of the pages goes through the host browser (not the relay), like in Chrome
    services: [...defaultServices(), webrtc()],
    handlers: {
      ...selectPopup(),
      ...colorPicker(),
      ...dateTimePicker(),
      ...permissionPrompt(),
      ...dialogHandler(),
    },
    permissions: profilePermissions,
    ...start.options,
    engine: engineOptions(),
    debug,
  };
  return debug ? withTestOptions(options) : options;
}

/** The tabs at the start: the last session (unless ?url=) or the start page. */
function openStartTabs(restarted: boolean): void {
  const url = restarted ? null : startUrl;
  const safe = !!storage(SAFE_START_KEY, undefined, true);
  storage(SAFE_START_KEY, null, true);
  const session = url ? null : sessionToRestore();
  if (!session) {
    openTab(url || DEFAULT_URL);
    return;
  }
  const restored = session.map((entry) => restoredTab(entry));
  if (safe) {
    openTab('about:blank');
    showNotice('After the restart the tabs load only when clicked');
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
  resetStartSettings();
  await start(true);
}

async function start(restarted: boolean): Promise<void> {
  const support = checkSupport();
  if (!support.supported) {
    showMessage('This browser cannot run browser-lite.', [
      `Missing: ${support.missing.join(', ')}`,
    ]);
    return;
  }
  const settings = startSettings();
  emulateDevice(settings);
  const token = tokenFor(relayUrl.host);
  transport = new WispTransport({ url: relayUrl, ...(token ? { token } : {}) });
  testState.transport = transport;
  const options = browserOptions(settings, transport);
  testState.options = options;
  let browser: Awaited<ReturnType<typeof createBrowser>>;
  try {
    browser = await createBrowser(options);
  } catch (error) {
    closeTransport();
    // An engine that could not be stopped keeps running: only a reload helps
    if (restarted && error instanceof BrowserLiteError && error.code === 'already-running') {
      reloadUI(addressWithoutUrl());
      return;
    }
    console.error(error);
    showMessage(`Error at start: ${(error as Error).message}`);
    return;
  }
  runtime.browser = browser;
  runtime.stopped = false;
  profile.attach(browser);
  browser.on('new-view', ({ view }) => adoptView(view));
  browser.on('download', ({ download }) => addDownload(download));
  browser.on('memory-pressure', () => discardForMemory());
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
onPreviewClosed(focusPage);
onBookmarksChange(() => {
  const tab = activeTab();
  if (tab) updateStar(tab.url);
});
installShortcuts();
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
