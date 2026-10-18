import {
  type Config,
  colorScheme,
  engineEnv,
  languages,
  preferenceFlags,
  preferences,
  resolveConfig,
} from './config.js';
import { Debug } from './debug.js';
import { DownloadImpl, decodeSource } from './downloads.js';
import { Emitter } from './emitter.js';
import { type EngineModule, loadEngineFactory } from './engine.js';
import { BrowserLiteError } from './errors.js';
import { Requests } from './requests.js';
import { Screen } from './screen.js';
import type { HostCall, ServiceContext } from './services/service.js';
import { holdStorageLock, namespaceDirectory } from './storage.js';
import { checkSupport } from './support.js';
import type {
  Browser,
  BrowserEvents,
  BrowserOptions,
  BrowserStorage,
  ColorScheme,
  Preferences,
  Unsubscribe,
  ViewOptions,
  WarningCode,
} from './types.js';
import { uploadDirectory, type ViewHost, ViewImpl } from './view.js';
import { Watchdog } from './watchdog.js';

const MAX_UPLOAD = 512 * 1024 * 1024;
const CONSOLE_LEVELS = ['log', 'warn', 'error', 'debug', 'info'] as const;

type EventHandler = (
  data: Record<string, unknown>,
  view: ViewImpl | undefined,
  viewId: number,
) => void;

/** The live browser of this page (one at a time). */
let live: BrowserImpl | null = null;
/** An earlier engine could not be stopped (engine without blShutdown): it still runs. */
let leaked = false;

/**
 * Starts the engine and resolves when it is ready. One browser per page at a time; destroy it
 * before creating the next.
 * @throws BrowserLiteError with code `invalid-options`, `not-cross-origin-isolated`,
 * `unsupported`, `already-running` or `engine-load-failed`.
 */
export async function createBrowser(options: BrowserOptions): Promise<Browser> {
  if (typeof location === 'undefined' || typeof document === 'undefined')
    throw new BrowserLiteError('unsupported', 'createBrowser needs a browser page', {
      missing: ['document'],
    });
  const config = resolveConfig(options, location.href);
  const support = checkSupport();
  if (support.missing.includes('crossOriginIsolated'))
    throw new BrowserLiteError(
      'not-cross-origin-isolated',
      'The page needs the headers Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp',
    );
  if (!support.supported)
    throw new BrowserLiteError('unsupported', `Missing: ${support.missing.join(', ')}`, {
      missing: support.missing,
    });
  if (live)
    throw new BrowserLiteError('already-running', 'A browser is already running on this page');
  if (leaked)
    throw new BrowserLiteError(
      'already-running',
      'The previous engine could not be stopped (engine without blShutdown); reload the page',
    );
  const browser = new BrowserImpl(config);
  live = browser;
  try {
    await browser.start();
  } catch (error) {
    await browser.destroy();
    throw error instanceof BrowserLiteError
      ? error
      : new BrowserLiteError('engine-load-failed', String((error as Error)?.message ?? error), {
          cause: error,
        });
  }
  return browser;
}

class StorageImpl implements BrowserStorage {
  persistent = false;
  directory: FileSystemDirectoryHandle | null = null;

  constructor(private readonly browser: BrowserImpl) {}

  flush(waitMs = 0): void {
    if (this.persistent && this.browser.ready) this.browser.module._bl_storage_flush(waitMs);
  }

  async clearCaches(): Promise<void> {
    const { module } = this.browser;
    await module.blClearHttpCache?.().catch(() => {});
    await module.blClearBytecodeCache?.().catch(() => {});
  }
}

class BrowserImpl implements Browser, ViewHost {
  private phase: 'starting' | Browser['state'] = 'starting';
  readonly views = new Map<number, ViewImpl>();
  readonly storage: StorageImpl;
  readonly debug?: Debug;
  readonly module: EngineModule;
  readonly watchdog: Watchdog;
  readonly requests: Requests;
  private readonly events = new Emitter<BrowserEvents>();
  private readonly lifetime = new AbortController();
  private readonly screen: Screen;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly hostCalls = new Map<string, HostCall<unknown>>();
  private readonly viewSetups: ((view: ViewImpl, signal: AbortSignal) => void)[] = [];
  private readonly gestureListeners: (() => void)[] = [];
  private readonly provided = new Map<string, unknown>();
  private readonly debugStates = new Map<string, () => unknown>();
  private readonly downloads = new Map<
    number,
    { download: DownloadImpl; view: number; source: boolean }
  >();
  private readonly warnings: [WarningCode, string][] = [];
  private readonly context: ServiceContext;
  private nextViewId = 1;
  private uploadCounter = 0;
  private focused: ViewImpl | null = null;
  private fullscreenView: ViewImpl | null = null;
  private pointerLockView: ViewImpl | null = null;
  private online = true;
  private releaseLock: (() => void) | null = null;
  private failStart: ((error: Error) => void) | null = null;

  constructor(readonly config: Config) {
    this.storage = new StorageImpl(this);
    this.module = this.createModule();
    this.watchdog = new Watchdog(this.module, (hung) =>
      this.events.emit(hung ? 'unresponsive' : 'responsive', {}),
    );
    this.requests = new Requests(this);
    this.screen = new Screen(this.module, config, () => {
      for (const view of this.views.values()) view.measure(true);
    });
    if (config.debug) this.debug = new Debug(this);
    this.context = this.serviceContext();
    this.registerCoreEvents();
  }

  get state(): Browser['state'] {
    return this.phase === 'starting' ? 'destroyed' : this.phase;
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  // ------------------------------------------------------------------ start

  async start(): Promise<void> {
    const { config } = this;
    const signal = this.lifetime.signal;
    let persistent = config.persistent;
    if (persistent) {
      this.releaseLock = await holdStorageLock(config.namespace);
      if (!this.releaseLock) {
        persistent = false;
        this.warn(
          'storage-locked',
          `Storage "${config.namespace}" is used by another tab: nothing is kept in this one`,
        );
      } else {
        this.storage.directory = await namespaceDirectory(config.namespace);
        // Without OPFS the engine keeps everything in memory
        persistent = !!this.storage.directory;
        if (this.storage.directory && config.beforeStart) {
          try {
            await config.beforeStart(this.storage.directory);
          } catch (error) {
            console.warn('[browser-lite] storage.beforeStart failed:', error);
          }
        }
      }
    }
    this.storage.persistent = persistent;

    // The synchronous part of setup (module hooks, handlers) runs now, async preparation
    // (service worker) while the engine loads
    const prepared = Promise.all(config.services.map((service) => service.setup(this.context)));
    prepared.catch(() => {});
    const features = [...new Set(config.services.flatMap((service) => service.features))];
    const env = engineEnv(config, features, persistent);
    this.module.preRun = [(module) => Object.assign(module.ENV, env)];

    // Engine errors (traps, aborts in threads) reach the page as error events. Only errors
    // of the engine scripts count: the embedding page may run WebAssembly of its own.
    const fromEngine = (error: unknown, filename = '') => {
      if (!(error instanceof WebAssembly.RuntimeError || error instanceof ErrorEvent)) return false;
      const base = config.engineBase;
      if (filename.startsWith(base)) return true;
      if (error instanceof ErrorEvent) return error.filename.startsWith(base);
      return (error.stack ?? '').includes(base);
    };
    addEventListener(
      'error',
      (event) => {
        if (fromEngine(event.error, event.filename))
          this.crashed(event.error.message || event.message);
      },
      { signal },
    );
    addEventListener(
      'unhandledrejection',
      (event) => {
        if (fromEngine(event.reason)) this.crashed(event.reason.message);
      },
      { signal },
    );

    const failed = new Promise<never>((_, reject) => {
      this.failStart = reject;
    });
    const ready = new Promise<void>((resolve) => {
      this.module.onEngineReady = resolve;
    });
    const factory = await Promise.race([
      loadEngineFactory(`${config.engineBase}engine.js`),
      failed,
    ]);
    await Promise.race([
      factory(this.module).then(
        () => ready,
        (error: unknown) => {
          throw new BrowserLiteError('engine-load-failed', `Engine start failed: ${error}`, {
            cause: error,
          });
        },
      ),
      failed,
    ]);
    await Promise.race([prepared, failed]);
    this.failStart = null;
    if (this.phase !== 'starting')
      throw new BrowserLiteError('destroyed', 'Destroyed while starting');
    this.phase = 'ready';
    this.afterReady();
  }

  private afterReady(): void {
    const { module, config } = this;
    const signal = this.lifetime.signal;
    module._bl_set_user_agent(this.text(config.userAgent), this.text(config.platform));
    module._bl_set_languages(this.text(config.languages.join(',')));
    module._bl_set_preferences(preferenceFlags(config.preferences));
    for (const [origin, kind, value] of config.permissions.entries())
      module._bl_set_permission(this.text(kind), this.text(origin), value === 'grant' ? 1 : 2);
    this.screen.start(signal);
    for (const service of config.services) service.start(this.context);
    this.watchdog.start();

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.storage.flush();
        for (const view of this.views.values()) view.updateVisibility();
      },
      { signal },
    );
    addEventListener('pagehide', () => this.storage.flush(500), { signal });
    document.addEventListener(
      'fullscreenchange',
      () => {
        const view = this.fullscreenView;
        if (document.fullscreenElement || !view) return;
        this.fullscreenView = null;
        if (view.alive) module._bl_exit_fullscreen(view.id);
      },
      { signal },
    );
    document.addEventListener(
      'pointerlockchange',
      () => {
        const view = [...this.views.values()].find((v) => v.canvas === document.pointerLockElement);
        const previous = this.pointerLockView;
        if (previous && previous !== view && previous.alive)
          module._bl_pointer_lock(previous.id, 0);
        this.pointerLockView = view ?? null;
      },
      { signal },
    );
    const updateOnline = () => this.updateOnline();
    config.transport.addEventListener('connectedchange', updateOnline, { signal });
    addEventListener('online', updateOnline, { signal });
    addEventListener('offline', updateOnline, { signal });
    this.updateOnline();

    // Warnings of the start go out once the caller could subscribe
    const warnings = this.warnings.splice(0);
    if (warnings.length)
      setTimeout(() => {
        for (const [code, message] of warnings) this.events.emit('warning', { code, message });
      });
  }

  private createModule(): EngineModule {
    const base = this.config.engineBase;
    const module: Partial<EngineModule> = {
      blTransport: this.config.transport,
      blHttpCacheDisabled: !this.config.httpCache,
      locateFile: (path) => new URL(path, base).href,
      mainScriptUrlOrBlob: `${base}engine.js`,
      print: (text) => console.log('[engine]', text),
      printErr: (text) => console.warn('[engine]', text),
      onAbort: (what) => this.crashed(String(what)),
      onEngineEvent: (view, type, payload, fromEngineThread) =>
        this.onEngineEvent(view, type, payload, fromEngineThread),
      onEngineFrame: (view, ptr, width, height, x, y, w, h) => {
        this.watchdog.answered();
        this.views.get(view)?.presentFrame(ptr, width, height, x, y, w, h);
        if (this.ready) this.module._bl_frame_presented(view);
      },
      onEngineNeedsFrame: (view) => {
        this.watchdog.answered();
        this.views.get(view)?.needsFrame();
      },
      onEngineDownloadData: (id, bytes) => this.downloads.get(id)?.download.add(bytes),
      onEnginePrint: (view, bytes, title) =>
        this.views
          .get(view)
          ?.emit('print', { pdf: new Blob([bytes], { type: 'application/pdf' }), title }),
      onEngineIcon: (view, _url, mime, bytes) =>
        this.views.get(view)?.emit('icon', {
          blob: bytes.length ? new Blob([bytes], { type: mime || 'image/x-icon' }) : null,
        }),
      engineDialog: (view, type, origin, message, defaultValue) => {
        this.watchdog.answered();
        return this.requests.dialog(this.views.get(view), type, origin, message, defaultValue);
      },
    };
    return module as EngineModule;
  }

  // ----------------------------------------------------------------- events

  private onEngineEvent(viewId: number, type: string, payload: string, fromEngineThread: boolean) {
    if (fromEngineThread) this.watchdog.answered();
    if (!this.ready) return;
    let data: Record<string, unknown> = {};
    try {
      if (payload) data = JSON.parse(payload);
    } catch {}
    const view = this.views.get(viewId);
    const handler = this.handlers.get(type);
    if (handler) handler(data, view, viewId);
    else view?.engineEvent(type, data);
  }

  private handle(type: string, handler: EventHandler): void {
    if (this.handlers.has(type)) throw new Error(`Engine event ${type} is handled twice`);
    this.handlers.set(type, handler);
  }

  private registerCoreEvents(): void {
    const withView =
      (fn: (view: ViewImpl, data: Record<string, unknown>) => void): EventHandler =>
      (data, view) => {
        if (view && !view.closed) fn(view, data);
      };
    this.handle('memory-pressure', () => this.events.emit('memory-pressure', {}));
    // Copy and cut in a page go to the clipboard of the host (with HTML like Chrome)
    this.handle('clipboard', (data) => {
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      const text = String(data.text ?? '');
      const writeText = () => clipboard.writeText(text).catch(() => {});
      if (data.html && typeof ClipboardItem === 'function') {
        const item = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([String(data.html)], { type: 'text/html' }),
        });
        clipboard.write([item]).catch(writeText);
      } else writeText();
    });
    this.handle('console', (data, view) => {
      const level = CONSOLE_LEVELS[Number(data.level)] ?? 'log';
      const message = String(data.message ?? '');
      const source = String(data.source ?? '');
      const line = Number(data.line) || 0;
      view?.emit('console', { level, message, source, line });
      if (this.config.debug)
        console[level](`[page ${view?.id ?? 0}] ${message}`, source ? `(${source}:${line})` : '');
    });
    this.handle('newview', (data, _view, viewId) => this.openEngineView(viewId, data));
    this.handle('download-start', (data, view) => this.downloadStart(data, view));
    this.handle('download-done', (data) => this.downloadDone(data));
    this.handle('host-call', (data, view) => this.hostCall(data, view));
    this.handle(
      'permission',
      withView((view, data) => {
        this.requests.permission(view, data as unknown as Parameters<Requests['permission']>[1]);
      }),
    );
    this.handle(
      'filechooser',
      withView((view, data) => {
        this.requests.fileChooser(view, data);
      }),
    );
    this.handle(
      'popup',
      withView((view, data) => {
        this.requests.selectPopup(view, data);
      }),
    );
    this.handle(
      'popup-hide',
      withView((view) => this.requests.hidePicker(view, 'select')),
    );
    this.handle(
      'colorpicker',
      withView((view, data) => {
        this.requests.colorPicker(view, data);
      }),
    );
    this.handle(
      'datetimepicker',
      withView((view, data) => {
        this.requests.dateTimePicker(view, data);
      }),
    );
    this.handle(
      'picker-hide',
      withView((view) => {
        this.requests.hidePicker(view, 'color');
        this.requests.hidePicker(view, 'datetime');
      }),
    );
  }

  // window.open or target=_blank: the engine opened the view already (with its own id)
  private openEngineView(id: number, data: Record<string, unknown>): void {
    const opener = this.views.get(Number(data.opener)) ?? null;
    const view = this.addView(id, {}, true);
    this.events.emit('new-view', { view, opener });
  }

  private async hostCall(data: Record<string, unknown>, view: ViewImpl | undefined) {
    const id = Number(data.id);
    const send = (ok: boolean, value: unknown) => {
      if (this.ready)
        this.module._bl_host_call_result(id, ok ? 1 : 0, this.text(JSON.stringify(value ?? null)));
    };
    const handler = this.hostCalls.get(String(data.name));
    if (!handler) {
      send(false, { name: 'NotSupportedError', message: 'Not supported' });
      return;
    }
    try {
      const payload = JSON.parse(String(data.payload || 'null'));
      send(true, await handler(payload, String(data.origin || ''), view));
    } catch (error) {
      const e = error as { name?: string; message?: string } | null;
      send(false, { name: e?.name || 'NotSupportedError', message: e?.message || String(error) });
    }
  }

  private downloadStart(data: Record<string, unknown>, view: ViewImpl | undefined): void {
    const download = new DownloadImpl(
      Number(data.id),
      String(data.filename ?? 'download'),
      String(data.mime ?? ''),
      String(data.url ?? ''),
      Number(data.size) || 0,
    );
    const source = !!data.viewSource;
    this.downloads.set(download.id, { download, view: view?.id ?? 0, source });
    if (!source) this.events.emit('download', { download });
  }

  private downloadDone(data: Record<string, unknown>): void {
    const entry = this.downloads.get(Number(data.id));
    if (!entry) return;
    this.downloads.delete(entry.download.id);
    const { download } = entry;
    download.finish(String(data.error ?? ''));
    if (entry.source) {
      // Page source (viewSource): the engine loaded the address like a download
      const view = this.views.get(entry.view);
      if (!download.blob || !view) return;
      download.blob.arrayBuffer().then((bytes) => {
        if (!view.closed)
          view.emit('source', { url: download.url, text: decodeSource(bytes, download.mime) });
      });
      return;
    }
    if (download.state === 'done' && !this.events.has('download')) download.save();
  }

  // ------------------------------------------------------------------ views

  private addView(id: number, options: ViewOptions, fromEngine: boolean): ViewImpl {
    const view = new ViewImpl(this, id, options, fromEngine);
    this.views.set(id, view);
    for (const setup of this.viewSetups) {
      try {
        setup(view, view.signal);
      } catch (error) {
        console.warn('[browser-lite] service view setup failed:', error);
      }
    }
    return view;
  }

  createView(options: ViewOptions = {}): ViewImpl {
    this.assertReady();
    if (typeof options !== 'object' || options === null)
      throw new BrowserLiteError('invalid-options', 'createView needs an options object');
    if (options.container !== undefined && !(options.container instanceof HTMLElement))
      throw new BrowserLiteError('invalid-options', 'container must be an HTMLElement');
    const id = this.nextViewId++;
    return this.addView(id, options, false);
  }

  removeView(view: ViewImpl): void {
    this.views.delete(view.id);
    if (this.focused === view) this.focused = null;
    if (this.pointerLockView === view) this.pointerLockView = null;
  }

  focusView(view: ViewImpl): void {
    if (this.focused === view) return;
    this.focused?.setEngineFocus(false);
    this.focused = view;
    view.setEngineFocus(true);
  }

  defaultSize(): { width: number; height: number } {
    for (const view of this.views.values()) if (view.viewSize.width) return view.viewSize;
    const device = this.config.device;
    return device ? { width: device.width, height: device.height } : { width: 1024, height: 768 };
  }

  pageHidden(): boolean {
    return document.hidden;
  }

  pixelRatio(): number {
    return this.screen.pixelRatio();
  }

  presenter(): Worker | null {
    return this.module.blPresenterWorker?.() ?? null;
  }

  gesture(): void {
    for (const listener of this.gestureListeners) listener();
  }

  text(value: string | null | undefined): number {
    return this.module.stringToNewUTF8(value ?? '');
  }

  notifications(): boolean {
    return !!this.provided.get('notifications');
  }

  // Files (upload, drop, paste) into the engine file system under /data/tmp (OPFS, not WASM
  // memory). The page reads them as long as it has its File objects (also after navigating),
  // so they are deleted only when the view closes. The engine thread reads the files itself.
  async writeUploads(view: ViewImpl, files: File[]): Promise<string[]> {
    const uploads: { name: string; file: File; path: string }[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      // A pasted image is called "image.png" in Chrome
      const name = (file.name || 'image.png').replace(/[/\n]/g, '_');
      if (file.size > MAX_UPLOAD) skipped.push(`${name} (larger than 512 MB)`);
      else
        uploads.push({
          name,
          file,
          path: `${uploadDirectory(view.id)}/${++this.uploadCounter}/${name}`,
        });
    }
    const write = this.module.blWriteFiles;
    const written =
      uploads.length && write && this.ready
        ? await write(uploads.map(({ file, path }) => ({ file, path })))
        : [];
    if (!view.alive) {
      // Closed meanwhile: its directory is gone, remove what came after
      if (this.ready) this.module._bl_remove_path(this.text(uploadDirectory(view.id)));
      return [];
    }
    const paths: string[] = [];
    uploads.forEach((upload, i) => {
      if (written[i]) paths.push(upload.path);
      else skipped.push(upload.name);
    });
    if (skipped.length) console.warn('[browser-lite] files not taken:', skipped.join(', '));
    return paths;
  }

  // Fullscreen of a page: the container of its view goes fullscreen in the host
  setFullscreen(view: ViewImpl, on: boolean): void {
    if (!on) {
      if (this.fullscreenView !== view) return;
      this.fullscreenView = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      return;
    }
    const element = view.element;
    const fail = () => {
      if (this.fullscreenView === view) this.fullscreenView = null;
      if (view.alive) this.module._bl_exit_fullscreen(view.id);
    };
    if (!element) {
      fail();
      return;
    }
    this.fullscreenView = view;
    // Without user activation the host refuses
    if (document.fullscreenElement !== element) element.requestFullscreen?.().catch(fail);
  }

  // Pointer lock (games, 3D): the mouse stays in the canvas, Esc of the host ends it
  setPointerLock(view: ViewImpl, on: boolean): void {
    const canvas = view.canvas;
    if (!on) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      return;
    }
    const request = canvas.requestPointerLock as (options?: {
      unadjustedMovement?: boolean;
    }) => Promise<void> | undefined;
    Promise.resolve(request.call(canvas, { unadjustedMovement: true }))
      .catch(() => request.call(canvas))
      .then(
        () => {
          if (view.alive)
            this.module._bl_pointer_lock(view.id, document.pointerLockElement === canvas ? 1 : 0);
        },
        () => {
          if (view.alive) this.module._bl_pointer_lock(view.id, 0);
        },
      );
  }

  // navigator.onLine of the pages: network of the host and connection of the transport
  private updateOnline(): void {
    const now = navigator.onLine && this.config.transport.connected;
    if (now === this.online || !this.ready) return;
    this.online = now;
    this.module._bl_set_online(now ? 1 : 0);
    this.events.emit('network', { connected: now });
  }

  // --------------------------------------------------------------- services

  private serviceContext(): ServiceContext {
    return {
      module: this.module,
      config: this.config,
      signal: this.lifetime.signal,
      text: (value) => this.text(value),
      engineWorker: () => this.module.blEngineWorker?.() ?? null,
      on: <T>(type: string, handler: (data: T, view: ViewImpl | undefined) => void) =>
        this.handle(type, handler as unknown as EventHandler),
      hostCall: <P>(name: string, handler: HostCall<P>) => {
        if (this.hostCalls.has(name)) throw new Error(`Host call ${name} is handled twice`);
        this.hostCalls.set(name, handler as HostCall<unknown>);
      },
      onView: (setup) => {
        this.viewSetups.push(setup);
      },
      onUserGesture: (listener) => {
        this.gestureListeners.push(listener);
      },
      provide: (key, value) => {
        this.provided.set(key, value);
      },
      use: <T>(key: string) => this.provided.get(key) as T | undefined,
      debugState: (name, state) => {
        this.debugStates.set(name, state);
      },
      warn: (code, message) => this.warn(code, message),
    };
  }

  debugState(name: 'audio' | 'media' | 'rtc'): unknown {
    return this.debugStates.get(name)?.() ?? null;
  }

  memoryPressure(): void {
    if (this.ready) this.events.emit('memory-pressure', {});
  }

  private warn(code: WarningCode, message: string): void {
    console.warn(`[browser-lite] ${message}`);
    if (this.phase === 'starting') this.warnings.push([code, message]);
    else this.events.emit('warning', { code, message });
  }

  // ----------------------------------------------------------------- public

  on<K extends keyof BrowserEvents>(
    type: K,
    listener: (event: BrowserEvents[K]) => void,
  ): Unsubscribe {
    return this.events.on(type, listener);
  }

  private assertReady(): void {
    if (this.phase === 'destroyed')
      throw new BrowserLiteError('destroyed', 'The browser was destroyed');
    if (this.phase === 'crashed') throw new BrowserLiteError('crashed', 'The engine crashed');
    if (this.phase !== 'ready') throw new BrowserLiteError('destroyed', 'The browser is not ready');
  }

  setColorScheme(scheme: ColorScheme): void {
    this.screen.colorScheme = colorScheme(scheme);
    if (this.ready) this.screen.send();
  }

  setLanguages(list: string[]): void {
    const checked = languages(list);
    this.config.languages = checked;
    if (this.ready) this.module._bl_set_languages(this.text(checked.join(',')));
  }

  setUserAgent(userAgent: string, platform = ''): void {
    if (typeof userAgent !== 'string' || typeof platform !== 'string')
      throw new BrowserLiteError('invalid-options', 'userAgent and platform must be strings');
    this.config.userAgent = userAgent;
    this.config.platform = platform;
    if (this.ready) this.module._bl_set_user_agent(this.text(userAgent), this.text(platform));
  }

  setPreferences(changes: Preferences): void {
    const merged = preferences({ ...this.config.preferences, ...changes });
    this.config.preferences = merged;
    if (this.ready) this.module._bl_set_preferences(preferenceFlags(merged));
  }

  // ---------------------------------------------------------------- the end

  private crashed(reason: string): void {
    if (this.phase === 'starting') {
      this.failStart?.(new BrowserLiteError('engine-load-failed', `Engine stopped: ${reason}`));
      return;
    }
    if (this.phase !== 'ready') return;
    this.phase = 'crashed';
    console.error('[browser-lite] engine crashed:', reason);
    this.watchdog.stop();
    this.requests.abortAll();
    this.lifetime.abort();
    this.events.emit('crash', { reason });
  }

  async destroy(): Promise<void> {
    if (this.phase === 'destroyed') return;
    const wasReady = this.ready;
    if (wasReady) this.storage.flush(500);
    this.watchdog.stop();
    this.requests.abortAll();
    // While still ready, so the engine closes the pages too
    for (const view of [...this.views.values()]) view.dispose();
    this.phase = 'destroyed';
    this.failStart?.(new BrowserLiteError('destroyed', 'Destroyed while starting'));
    this.lifetime.abort();
    const module = this.module;
    if (typeof module.blShutdown === 'function') {
      try {
        module.blShutdown();
      } catch (error) {
        console.warn('[browser-lite] engine shutdown failed:', error);
        leaked = true;
      }
    } else if (module.HEAPU8) {
      // An engine without blShutdown keeps its threads: no second engine on this page
      leaked = true;
    }
    for (const key of Object.keys(module) as (keyof EngineModule)[])
      if (key.startsWith('on') || key === 'engineDialog' || key === 'blTransport')
        delete (module as unknown as Record<string, unknown>)[key];
    this.releaseLock?.();
    this.releaseLock = null;
    this.storage.persistent = false;
    this.storage.directory = null;
    this.events.clear();
    if (live === this) live = null;
  }
}
