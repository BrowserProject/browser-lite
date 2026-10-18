// Test host of @browser-lite/core: the views fill the page, only the public package entry points
// are used. window.blTest is the shared test hook object (same as the demo with ?debug=1);
// window.blHost holds what only this page offers to tests/core/smoke-test.mjs (recorded events,
// request answers, start/stop). Before the start a test may set window.blTestOptions (merged
// into the BrowserOptions).
//   ?relay=ws://host/wisp/  relay URL (default: /wisp/ of this server)
//   ?engine=/engine/        engine folder
//   ?url=...                first page
//   ?persistent=1           storage in OPFS (beforeStart records the directory name)
//   ?namespace=name         storage namespace (with persistent=1)
//   ?device=400x300x2       emulated device (width x height x pixel ratio)
//   ?manual=1               no start on load
import { checkSupport, createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const params = new URLSearchParams(location.search);
const relay = params.get('relay') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
const engineUrl = params.get('engine') || '/engine/';
const container = document.getElementById('view');

let browser = null;
let transport = null;
let active = null;
const views = [];
const flags = { firstLayout: false, firstPaint: false, loaded: false };

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

function merge(base, extra) {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra ?? {}))
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  return result;
}

function deviceOption(text) {
  const [width, height, pixelRatio] = text.split('x').map(Number);
  return { width, height, pixelRatio };
}

function activate(view) {
  if (active && active !== view && !active.closed) active.setVisible(false);
  active = view;
  view.setVisible(true);
  view.focus();
}

// Every view of the browser: recorded events, flags, and the active one is visible
function track(view, prefix) {
  views.push(view);
  const record = (text) => host.events.push(prefix + text);
  view.on('navigation', ({ url }) => record(`navigation:${url}`));
  view.on('title', ({ title }) => record(`title:${title}`));
  view.on('commit', ({ errorPage }) => record(`commit:${errorPage ?? ''}`));
  view.on('first-layout', () => {
    flags.firstLayout = true;
  });
  view.on('first-paint', () => {
    flags.firstPaint = true;
    record('first-paint');
  });
  view.on('load', () => {
    flags.loaded = true;
    record('load');
  });
  for (const type of ['user-activation', 'close']) view.on(type, () => record(type));
  view.on('console', ({ level, message }) => record(`console:${level}:${message}`));
  view.on('find', ({ matches }) => record(`find:${matches}`));
  view.on('zoom', ({ zoom }) => record(`zoom:${zoom}`));
  view.on('hover', ({ url }) => record(`hover:${url ?? ''}`));
  view.on('context-menu', ({ x, y, editable }) => record(`context-menu:${x},${y},${editable}`));
  view.on('print', ({ pdf }) => record(`print:${pdf.type}:${pdf.size > 1000}`));
  view.on('source', ({ text }) => {
    host.source = text;
  });
  view.on('close', () => {
    views.splice(views.indexOf(view), 1);
    if (active === view) {
      active = null;
      if (views.length) activate(views[views.length - 1]);
    }
  });
}

const blTest = {
  get browser() {
    return browser;
  },
  view: () => active,
  views: () => [...views],
  open(url) {
    const view = browser.createView({ container, url: url || undefined });
    track(view, '');
    activate(view);
    return view;
  },
  load(url) {
    active.load(url);
  },
  eval: (source) => browser.debug.eval(active, source),
  pagePixel: (x, y) => browser.debug.pagePixel(active, x, y),
  pageRow: (y) => browser.debug.pageRow(active, y),
  memory: (report) => browser.debug.memory(report),
  memoryPressure: () => browser.debug.memoryPressure(),
  crash: (kind) => browser.debug.crash(kind),
  audioState: () => browser.debug.audioState(),
  mediaState: () => browser.debug.mediaState(),
  rtcState: () => browser.debug.rtcState(),
  flags,
};

const host = {
  support: checkSupport(),
  ready: null,
  error: null,
  beforeStart: null,
  source: null,
  events: [],
  warnings: [],
  downloads: [],
  selectRequests: [],
  selectAnswer: -1,
  permissionAnswer: 'deny',
  fileAnswer: null,
  /** Starts a browser with one view (again after stop); options are merged in last. */
  async start(options = {}) {
    host.error = null;
    transport = new WispTransport({ url: relay });
    const storage = params.get('persistent')
      ? {
          persistent: true,
          namespace: params.get('namespace') || undefined,
          beforeStart: async (directory) => {
            host.beforeStart = directory.name;
          },
        }
      : { persistent: false };
    const base = {
      engineUrl,
      transport,
      debug: true,
      serviceWorker: { url: new URL('sw.js', location.href), scope: './' },
      storage,
      ...(params.get('device') ? { device: deviceOption(params.get('device')) } : {}),
      handlers: {
        selectPopup(request) {
          host.selectRequests.push({ items: request.items.map((item) => item.text), selectedIndex: request.selectedIndex, rect: request.rect });
          return Promise.resolve(host.selectAnswer);
        },
        permission(request) {
          host.events.push(`permission:${request.kind}`);
          return Promise.resolve(host.permissionAnswer);
        },
        fileChooser(request) {
          host.events.push(`filechooser:${request.multiple}`);
          return Promise.resolve(host.fileAnswer ? host.fileAnswer.map(([name, text]) => new File([text], name)) : null);
        },
        dialog(request) {
          host.events.push(`dialog:${request.type}:${request.message}`);
          return request.type === 'prompt' ? 'answer' : true;
        },
      },
    };
    try {
      browser = await createBrowser(merge(merge(base, window.blTestOptions), options));
    } catch (error) {
      host.error = { code: error.code, message: error.message };
      transport.close();
      throw error;
    }
    browser.on('warning', (event) => host.warnings.push(event.code));
    browser.on('download', ({ download }) => {
      const entry = { filename: download.filename, state: download.state, size: 0, text: null };
      host.downloads.push(entry);
      download.on('done', async () => {
        entry.state = download.state;
        entry.size = download.blob.size;
        entry.text = await download.blob.text();
      });
      download.on('error', () => {
        entry.state = download.state;
      });
    });
    browser.on('crash', ({ reason }) => host.events.push(`crash:${reason}`));
    for (const type of ['unresponsive', 'responsive', 'memory-pressure'])
      browser.on(type, () => host.events.push(type));
    // Views the pages open (window.open, target=_blank) become the active view
    browser.on('new-view', ({ view, opener }) => {
      host.events.push(`new-view:${opener?.id ?? 0}`);
      view.attach(container);
      track(view, 'popup-');
      activate(view);
    });
    blTest.open(params.get('url'));
    return true;
  },
  async stop() {
    await browser?.destroy();
    transport?.close();
    browser = null;
    transport = null;
    active = null;
    views.length = 0;
  },
};

window.blTest = blTest;
window.blHost = host;
host.ready = params.get('manual') ? Promise.resolve(false) : host.start().catch(() => false);
