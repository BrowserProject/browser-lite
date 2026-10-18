// Test host of @browser-lite/core: one view filling the page, everything reachable through
// window.blTest for tests/core/smoke-test.mjs. Uses only the public package entry points.
//   ?relay=ws://host/wisp/  relay URL (default: /wisp/ of this server)
//   ?engine=/engine/        engine folder
//   ?transport=legacy       the old client web/transport.js instead of @browser-lite/transport-wisp
//   ?legacyCloseCodes=1     pass its numeric close codes through (engines before the string contract)
//   ?url=...                first page
//   ?persistent=1           storage in OPFS (beforeStart records the directory name)
//   ?device=400x300x2       emulated device (width x height x pixel ratio)
import { checkSupport, createBrowser } from '@browser-lite/core';

const params = new URLSearchParams(location.search);
const relay = params.get('relay') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
const engineUrl = params.get('engine') || '/engine/';

// Wisp close codes of web/transport.js -> CloseReason of the core contract
const CLOSE_REASONS = { 2: 'closed', 0x41: 'invalid', 0x42: 'name-not-resolved', 0x43: 'timeout', 0x44: 'refused', 0x47: 'timeout', 0x48: 'blocked', 0x49: 'throttled', 0x4a: 'unreachable' };

class LegacyTransport extends EventTarget {
  constructor(Transport, url, passCodes) {
    super();
    this.inner = new Transport(url);
    this.passCodes = passCodes;
    this.inner.onconnectedchange = () => this.dispatchEvent(new Event('connectedchange'));
  }

  get connected() {
    return this.inner.connected;
  }

  openTCP(host, port) {
    const stream = this.inner.openTCP(host, port);
    if (this.passCodes)
      return stream;
    const wrapper = {
      send: (data) => stream.send(data),
      close: () => stream.close(),
      onopen: null,
      ondata: null,
      onsent: null,
      onclose: null,
    };
    stream.onopen = () => wrapper.onopen?.();
    stream.ondata = (data) => wrapper.ondata?.(data);
    stream.onsent = (bytes) => wrapper.onsent?.(bytes);
    stream.onclose = (code) => wrapper.onclose?.(typeof code === 'number' ? CLOSE_REASONS[code] || (code === 0x03 ? 'transport-down' : 'reset') : code);
    return wrapper;
  }
}

function deviceOption(text) {
  const [width, height, pixelRatio] = text.split('x').map(Number);
  return { width, height, pixelRatio };
}

async function makeTransport() {
  if (params.get('transport') !== 'legacy') {
    try {
      const { WispTransport } = await import('@browser-lite/transport-wisp');
      return { transport: new WispTransport({ url: relay }), kind: 'wisp' };
    } catch (error) {
      console.warn('transport-wisp not available, using web/transport.js:', error.message);
    }
  }
  const { WispTransport } = await import('/web/transport.js');
  return { transport: new LegacyTransport(WispTransport, relay, params.get('legacyCloseCodes') === '1'), kind: 'legacy' };
}

const test = {
  browser: null,
  view: null,
  transportKind: '',
  support: checkSupport(),
  events: [],
  downloads: [],
  selectRequests: [],
  selectAnswer: -1,
  permissionAnswer: 'deny',
  fileAnswer: null,
  views: [],
  warnings: [],
  error: null,
  /** Starts a browser with one view (again after destroy). */
  async start(options = {}) {
    test.error = null;
    const { transport, kind } = await makeTransport();
    test.transportKind = kind;
    try {
      test.browser = await createBrowser({
        engineUrl,
        transport,
        debug: true,
        serviceWorker: { url: new URL('sw.js', location.href), scope: './' },
        storage: params.get('persistent')
          ? { persistent: true, beforeStart: async (directory) => { test.beforeStart = directory.name; } }
          : { persistent: false },
        ...(params.get('device') ? { device: deviceOption(params.get('device')) } : {}),
        handlers: {
          selectPopup(request) {
            test.selectRequests.push({ items: request.items.map((item) => item.text), selectedIndex: request.selectedIndex, rect: request.rect });
            return Promise.resolve(test.selectAnswer);
          },
          permission(request) {
            test.events.push(`permission:${request.kind}`);
            return Promise.resolve(test.permissionAnswer);
          },
          fileChooser(request) {
            test.events.push(`filechooser:${request.multiple}`);
            return Promise.resolve(test.fileAnswer ? test.fileAnswer.map(([name, text]) => new File([text], name)) : null);
          },
          dialog(request) {
            test.events.push(`dialog:${request.type}:${request.message}`);
            return request.type === 'prompt' ? 'answer' : true;
          },
        },
        ...options,
      });
    } catch (error) {
      test.error = { code: error.code, message: error.message };
      throw error;
    }
    const browser = test.browser;
    browser.on('warning', (event) => test.warnings.push(event.code));
    browser.on('download', ({ download }) => {
      const entry = { filename: download.filename, state: download.state, size: 0, text: null };
      test.downloads.push(entry);
      download.on('done', async () => {
        entry.state = download.state;
        entry.size = download.blob.size;
        entry.text = await download.blob.text();
      });
      download.on('error', () => {
        entry.state = download.state;
      });
    });
    browser.on('crash', ({ reason }) => test.events.push(`crash:${reason}`));
    for (const type of ['unresponsive', 'responsive', 'memory-pressure'])
      browser.on(type, () => test.events.push(type));
    browser.on('new-view', ({ view, opener }) => {
      test.views.push(view);
      test.events.push(`new-view:${opener?.id ?? 0}`);
      view.on('navigation', ({ url }) => test.events.push(`popup-navigation:${url}`));
      view.on('close', () => test.events.push('popup-close'));
    });
    const view = browser.createView({ container: document.getElementById('view'), url: params.get('url') || undefined });
    test.view = view;
    view.on('navigation', ({ url }) => test.events.push(`navigation:${url}`));
    view.on('title', ({ title }) => {
      test.title = title;
      test.events.push(`title:${title}`);
    });
    for (const type of ['load', 'commit', 'first-paint', 'user-activation', 'close'])
      view.on(type, () => test.events.push(type));
    view.on('console', ({ level, message }) => test.events.push(`console:${level}:${message}`));
    view.on('find', ({ matches }) => test.events.push(`find:${matches}`));
    view.on('zoom', ({ zoom }) => test.events.push(`zoom:${zoom}`));
    view.on('context-menu', ({ x, y, editable }) => test.events.push(`context-menu:${x},${y},${editable}`));
    view.on('print', ({ pdf }) => test.events.push(`print:${pdf.type}:${pdf.size > 1000}`));
    view.on('source', ({ text }) => {
      test.source = text;
    });
    view.focus();
    return true;
  },
  open(url) {
    test.view.load(url);
    test.view.focus();
  },
  async stop() {
    await test.browser?.destroy();
    test.browser = null;
    test.view = null;
  },
  pagePixel: (x, y) => test.browser.debug.pagePixel(test.view, x, y),
};
window.blTest = test;
test.ready = params.get('manual') ? Promise.resolve(false) : test.start().catch(() => false);
