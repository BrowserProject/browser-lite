// Test host of @browser-lite/core: the views fill the page, only the public package entry points
// are used. window.blTest is the shared test hook object (same as the demo with ?debug=1);
// window.blHost holds what only this page offers to the tests in tests/core (recorded events,
// request answers, start/stop, switching views). Before the start a test may set
// window.blTestOptions (merged into the BrowserOptions).
//   ?relay=ws://host/wisp/  relay URL (default: /wisp/ of this server)
//   ?token=...              token for the relay
//   ?engine=/engine/        engine folder
//   ?url=...                first page
//   ?persistent=1           storage in OPFS (beforeStart records the directory name)
//   ?namespace=name         storage namespace (with persistent=1)
//   ?device=400x300x2       emulated device (width x height x pixel ratio, x1 at the end: touch)
//   ?services=a,b           services by name (default, audio, media, capture, devices, webrtc,
//                           none); default: defaultServices()
//   ?log=1, ?gpu=0, ?compositing=0|1, ?safepointgc=0|1|debug, ?httpcache=0, ?scripttimeout=s
//                           engine switches
//   ?env=KEY=value,...      expert switches (engine.env)
//   ?manual=1               no start on load
import {
  audio,
  capture,
  checkSupport,
  createBrowser,
  defaultServices,
  devices,
  media,
  webrtc,
} from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const params = new URLSearchParams(location.search);
const relay =
  params.get('relay') ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
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
    result[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  return result;
}

function deviceOption(text) {
  const [width, height, pixelRatio, touch] = text.split('x').map(Number);
  return { width, height, pixelRatio, ...(touch ? { touch: true, mobile: true } : {}) };
}

const SERVICES = { audio, media, capture, devices, webrtc };
function servicesOption(text) {
  if (text === null) return undefined;
  return text
    .split(',')
    .filter((name) => name && name !== 'none')
    .flatMap((name) => (name === 'default' ? defaultServices() : [SERVICES[name]()]));
}

function engineOptions() {
  const flag = (name) => (params.has(name) ? params.get(name) !== '0' : undefined);
  const safepoint = params.get('safepointgc');
  const env = Object.fromEntries(
    (params.get('env') || '')
      .split(',')
      .filter((pair) => pair.includes('='))
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );
  const options = {
    log: params.get('log') === '1' || undefined,
    gpu: flag('gpu'),
    compositing: flag('compositing'),
    httpCache: flag('httpcache'),
    safepointGC:
      safepoint === 'debug' ? 'debug' : safepoint === null ? undefined : safepoint !== '0',
    scriptTimeoutSeconds: params.has('scripttimeout')
      ? Number(params.get('scripttimeout'))
      : undefined,
    env: Object.keys(env).length ? env : undefined,
  };
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
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
  view.on('error', ({ description }) => record(`error:${description}`));
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
  for (const type of ['user-activation', 'close', 'focus-request'])
    view.on(type, () => record(type));
  view.on('console', ({ level, message }) => record(`console:${level}:${message}`));
  view.on('find', ({ matches }) => record(`find:${matches}`));
  view.on('zoom', ({ zoom }) => record(`zoom:${zoom}`));
  view.on('hover', ({ url }) => record(`hover:${url ?? ''}`));
  view.on('context-menu', (info) => {
    record(`context-menu:${info.x},${info.y},${info.editable}`);
    host.contextMenus.push({ view: view.id, ...info });
  });
  view.on('print', ({ pdf }) => record(`print:${pdf.type}:${pdf.size > 1000}`));
  view.on('icon', ({ blob }) => {
    record(`icon:${blob?.size ?? 0}`);
    if (!blob) return;
    // Like an <img> of a tab strip (createImageBitmap cannot decode SVG)
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => record(`icon-image:${image.naturalWidth}x${image.naturalHeight}`);
    image.onerror = () => record('icon-image:invalid');
    image.onloadend = () => URL.revokeObjectURL(url);
    image.src = url;
  });
  view.on('external-url', ({ url }) => record(`external-url:${url}`));
  view.on('open-tab', ({ url }) => record(`open-tab:${url}`));
  view.on('take-focus', ({ forward }) => record(`take-focus:${forward}`));
  view.on('fullscreen', ({ active: on }) => record(`fullscreen:${on}`));
  view.on('media-state', ({ audible }) => record(`media-state:${audible}`));
  view.on('capture-state', ({ active: on }) => record(`capture-state:${on}`));
  view.on('picture-in-picture', ({ active: on }) => record(`picture-in-picture:${on}`));
  view.on('beforeunload-state', ({ hasListener }) => record(`beforeunload-state:${hasListener}`));
  view.on('files-skipped', ({ files }) =>
    record(`files-skipped:${files.map(({ name, reason }) => `${name}:${reason}`).join()}`),
  );
  view.on('source', ({ text }) => {
    host.source = text;
  });
  // window.focus() (for example WindowClient.focus() of a service worker) makes the view active
  view.on('focus-request', () => activate(view));
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
  measurements: () => browser.debug.measurements(),
  flags,
};

// Native dialogs of the host page block its main thread like a real embedding would
function nativeDialog(request) {
  if (request.type === 'confirm' || request.type === 'beforeunload')
    return confirm(request.message);
  if (request.type === 'prompt') return prompt(request.message, request.defaultValue);
  alert(request.message);
  return undefined;
}

async function askPermission(request) {
  host.events.push(`permission:${request.kind}`);
  host.permissionRequests.push({
    kind: request.kind,
    origin: request.origin,
    view: request.view.id,
  });
  const answer = host.permissionAnswers[request.kind] ?? host.permissionAnswer;
  if (answer === 'wait')
    return new Promise((resolve) => {
      request.signal.addEventListener('abort', () => {
        host.events.push(`permission-aborted:${request.kind}`);
        resolve('dismiss');
      });
    });
  // The core leaves the host notification permission to the handler
  if (request.kind === 'notifications' && answer === 'grant')
    return (await Notification.requestPermission()) === 'granted' ? 'grant' : 'deny';
  return answer;
}

const host = {
  support: checkSupport(),
  ready: null,
  error: null,
  beforeStart: null,
  source: null,
  events: [],
  warnings: [],
  downloads: [],
  contextMenus: [],
  dialogs: [],
  selectRequests: [],
  colorRequests: [],
  dateRequests: [],
  permissionRequests: [],
  /** Index of the <select> item, -1 cancels. */
  selectAnswer: -1,
  /**
   * 'grant', 'deny', 'dismiss' or 'wait' (until the request is aborted); per kind in
   * permissionAnswers.
   */
  permissionAnswer: 'deny',
  permissionAnswers: {},
  /** [[name, text, type?], ...] or null (cancel). */
  fileAnswer: null,
  colorAnswer: null,
  dateAnswer: null,
  /**
   * 'answer': confirm true, prompt 'answer'; 'async': the same after dialogDelay ms (a promise);
   * 'native': the dialogs of the host page.
   */
  dialogMode: 'answer',
  dialogDelay: 1000,
  /** Download objects of the 'download' event (for cancel()). */
  downloadObjects: [],
  /** False: start without a 'new-view' listener (popups load in their opener). */
  listenNewView: true,
  /** Makes the view at index (in opening order) the active one. */
  select(index) {
    activate(views[index]);
  },
  /** Starts a browser with one view (again after stop); options are merged in last. */
  async start(options = {}) {
    host.error = null;
    transport = new WispTransport({
      url: relay,
      ...(params.get('token') ? { token: params.get('token') } : {}),
    });
    const storage = params.get('persistent')
      ? {
          persistent: true,
          namespace: params.get('namespace') || undefined,
          beforeStart: async (directory) => {
            host.beforeStart = directory.name;
          },
        }
      : { persistent: false };
    const services = servicesOption(params.get('services'));
    const base = {
      engineUrl,
      transport,
      debug: true,
      serviceWorker: { url: new URL('sw.js', location.href), scope: './' },
      storage,
      engine: engineOptions(),
      ...(services ? { services } : {}),
      ...(params.get('device') ? { device: deviceOption(params.get('device')) } : {}),
      handlers: {
        selectPopup(request) {
          host.selectRequests.push({
            items: request.items.map((item) => item.text),
            labels: request.items.map((item) => (item.label ? 'group' : 'option')),
            selectedIndex: request.selectedIndex,
            rect: request.rect,
          });
          return Promise.resolve(host.selectAnswer);
        },
        colorPicker(request) {
          host.colorRequests.push({ value: request.value, rect: request.rect });
          return Promise.resolve(host.colorAnswer);
        },
        dateTimePicker(request) {
          host.dateRequests.push({ type: request.type, value: request.value, rect: request.rect });
          return Promise.resolve(host.dateAnswer);
        },
        permission: askPermission,
        fileChooser(request) {
          host.events.push(`filechooser:${request.multiple}`);
          return Promise.resolve(
            host.fileAnswer
              ? host.fileAnswer.map(
                  ([name, text, type]) => new File([text], name, type ? { type } : {}),
                )
              : null,
          );
        },
        dialog(request) {
          host.events.push(`dialog:${request.type}:${request.message}`);
          host.dialogs.push({
            type: request.type,
            origin: request.origin,
            message: request.message,
            view: request.view.id,
          });
          if (host.dialogMode === 'native') return nativeDialog(request);
          const answer = request.type === 'prompt' ? 'answer' : true;
          if (host.dialogMode === 'async')
            return new Promise((resolve) => setTimeout(() => resolve(answer), host.dialogDelay));
          return answer;
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
      const entry = {
        filename: download.filename,
        mime: download.mime,
        url: download.url,
        state: download.state,
        size: 0,
        text: null,
        error: null,
      };
      host.downloads.push(entry);
      host.downloadObjects.push(download);
      download.on('done', async () => {
        entry.state = download.state;
        entry.size = download.blob.size;
        entry.text = await download.blob.text();
      });
      download.on('error', () => {
        entry.state = download.state;
        entry.error = download.error ?? null;
      });
    });
    browser.on('crash', ({ reason }) => host.events.push(`crash:${reason}`));
    browser.on('network', ({ connected }) => host.events.push(`network:${connected}`));
    for (const type of ['unresponsive', 'responsive', 'memory-pressure'])
      browser.on(type, () => host.events.push(type));
    // Views the pages open (window.open, target=_blank) become the active view
    if (host.listenNewView)
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
