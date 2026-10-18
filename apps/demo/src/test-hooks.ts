import type { Browser, BrowserOptions, DebugApi, Transport, View } from '@browser-lite/core';
import { addressToURL } from './address-bar.js';
import { relayUrl, tokenFor } from './params.js';
import { profile, runtime } from './runtime.js';
import { settings } from './settings.js';
import { activeTab, allTabs, discardForMemory, onTabCreated, openTab } from './tabs.js';

declare global {
  interface Window {
    /** Test hooks (only with ?debug=1), the same shape as the core test host page. */
    blTest?: unknown;
    /** Set by a test before the start: merged into the options of createBrowser. */
    blTestOptions?: Partial<BrowserOptions>;
  }
}

/** Set from the events of any view, for tests that wait for the first page. */
const flags = { firstLayout: false, firstPaint: false, loaded: false };

/** What the hooks need from the start of the demo. */
export interface TestState {
  transport: Transport | null;
  options: BrowserOptions | null;
}

function debugApi(): DebugApi {
  const debug = runtime.browser?.debug;
  if (!debug) throw new Error('No browser with debug: true running');
  return debug;
}

function view(): View {
  const current = activeTab()?.view;
  if (!current) throw new Error('No active view');
  return current;
}

/** Options a test set with page.addInitScript (window.blTestOptions), merged into options. */
export function withTestOptions(options: BrowserOptions): BrowserOptions {
  const extra = window.blTestOptions;
  if (!extra) return options;
  return { ...options, ...extra, engine: { ...options.engine, ...extra.engine } };
}

/**
 * window.blTest for the e2e tests (tests/core and tests/demo): the browser, its views and the debug API,
 * plus hooks of the demo (checkMemory, memoryUsed, gpu, profile, settings, addressToURL, transport, relay,
 * options).
 */
export function installTestHooks(state: TestState): void {
  onTabCreated((tab) => {
    tab.view.on('first-layout', () => {
      flags.firstLayout = true;
    });
    tab.view.on('first-paint', () => {
      flags.firstPaint = true;
    });
    tab.view.on('load', () => {
      flags.loaded = true;
    });
  });
  window.blTest = {
    get browser(): Browser | null {
      return runtime.browser;
    },
    view: () => activeTab()?.view ?? null,
    views: () => allTabs().map((tab) => tab.view),
    open: (url: string) => openTab(url)?.view ?? null,
    load: (url: string) => view().load(url),
    eval: (source: string) => debugApi().eval(view(), source),
    pagePixel: (x: number, y: number) => debugApi().pagePixel(view(), x, y),
    pageRow: (y: number) => debugApi().pageRow(view(), y),
    memory: (report?: 0 | 1 | 2 | 3) => debugApi().memory(report),
    memoryPressure: () => debugApi().memoryPressure(),
    crash: (kind: 'abort' | 'trap') => debugApi().crash(kind),
    audioState: () => debugApi().audioState(),
    mediaState: () => debugApi().mediaState(),
    rtcState: () => debugApi().rtcState(),
    flags,
    /** Discards a background tab like on memory pressure; the id of the new view or 0. */
    checkMemory: () => discardForMemory()?.view.id ?? 0,
    memoryUsed: () => debugApi().memoryUsed(),
    gpu: (action: 'lose' | 'restore' | 'lose-webgl') => debugApi().gpu(action),
    profile,
    settings,
    addressToURL,
    get transport() {
      return state.transport;
    },
    /** The relay of this load and whether a token goes with it. */
    relay: { url: relayUrl.href, token: !!tokenFor(relayUrl.host) },
    get options() {
      return state.options;
    },
  };
}
