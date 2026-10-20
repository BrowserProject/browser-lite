import { writeHostClipboard } from './clipboard.js';
import {
  type Config,
  colorScheme,
  engineEnv,
  languages,
  PERMISSION_KINDS,
  permissionChange,
  preferenceFlags,
  preferences,
  resolveConfig,
} from './config.js';
import { Debug } from './debug.js';
import { Downloads } from './downloads.js';
import { Emitter } from './emitter.js';
import { checkEngine, type EngineModule, loadEngineFactory } from './engine.js';
import { BrowserLiteError } from './errors.js';
import { Fullscreen } from './fullscreen.js';
import { Online } from './online.js';
import { storePermission } from './permissions.js';
import { redirectPopup } from './popups.js';
import { Requests } from './requests.js';
import { Screen } from './screen.js';
import { ServiceRegistry } from './service-context.js';
import { holdStorageLock, namespaceDirectory } from './storage.js';
import { checkSupport } from './support.js';
import type {
  Browser,
  BrowserEvents,
  BrowserOptions,
  BrowserStorage,
  ColorScheme,
  Download,
  PermissionDecision,
  PermissionKind,
  Preferences,
  Unsubscribe,
  ViewOptions,
  WarningCode,
} from './types.js';
import { Uploads } from './uploads.js';
import { type ViewHost, ViewImpl } from './view.js';
import { Watchdog } from './watchdog.js';

const CONSOLE_LEVELS = ['log', 'warn', 'error', 'debug', 'info'] as const;

type EventHandler = (
  data: Record<string, unknown>,
  view: ViewImpl | undefined,
  viewId: number,
) => void;

/** The live browser of this page (one at a time). */
let live: BrowserImpl | null = null;
/** An earlier engine could not be stopped (blShutdown failed): its threads may still run. */
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
      'The previous engine could not be stopped; reload the page',
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
  readonly uploads: Uploads;
  readonly fullscreen: Fullscreen;
  private readonly events = new Emitter<BrowserEvents>();
  private readonly lifetime = new AbortController();
  private readonly screen: Screen;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly services: ServiceRegistry;
  private readonly downloads: Downloads;
  private readonly network: Online;
  private readonly warnings: [WarningCode, string][] = [];
  private nextViewId = 1;
  private focused: ViewImpl | null = null;
  private releaseLock: (() => void) | null = null;
  private failStart: ((error: Error) => void) | null = null;

  constructor(readonly config: Config) {
    this.storage = new StorageImpl(this);
    this.module = this.createModule();
    this.watchdog = new Watchdog(this.module, (hung) =>
      this.events.emit(hung ? 'unresponsive' : 'responsive', {}),
    );
    this.requests = new Requests(this);
    this.uploads = new Uploads(this);
    this.fullscreen = new Fullscreen(this.module, () => this.views.values());
    this.network = new Online(this.module, config.transport, (connected) =>
      this.events.emit('network', { connected }),
    );
    this.downloads = new Downloads(this);
    this.screen = new Screen(this.module, config, () => {
      for (const view of this.views.values()) view.measure(true);
    });
    if (config.debug) this.debug = new Debug(this);
    this.services = new ServiceRegistry(this, this.lifetime.signal);
    this.registerCoreEvents();
  }

  get state(): Browser['state'] {
    return this.phase === 'starting' ? 'destroyed' : this.phase;
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  get online(): boolean {
    return this.network.value;
  }

  /** Emits `download`; false when nobody listens. */
  announceDownload(download: Download): boolean {
    this.events.emit('download', { download });
    return this.events.has('download');
  }

  async start(): Promise<void> {
    const { config } = this;
    const signal = this.lifetime.signal;
    // Steps of the start on the timeline of the page (tests/perf, only with debug)
    const mark = (step: string) => {
      if (config.debug) performance.mark(`bl:${step}`);
    };
    let persistent = config.persistent;
    if (persistent) {
      this.releaseLock = await holdStorageLock(config.namespace);
      mark('lock');
      if (!this.releaseLock) {
        persistent = false;
        this.warn(
          'storage-locked',
          `Storage "${config.namespace}" is used by another tab: data stays in memory here`,
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
          mark('beforeStart');
        }
      }
    }
    this.storage.persistent = persistent;

    // The synchronous part of setup (module hooks, handlers) runs now, async preparation
    // (service worker) while the engine loads
    const context = this.services.context;
    const prepared = Promise.all(config.services.map((service) => service.setup(context)));
    prepared.then(() => mark('prepared')).catch(() => {});
    const features = [...new Set(config.services.flatMap((service) => service.features))];
    const env = engineEnv(config, features, persistent);
    // Emscripten calls preRun once the WebAssembly instance exists, onRuntimeInitialized right
    // before main()
    this.module.preRun = [
      (module) => {
        mark('instantiate');
        Object.assign(module.ENV, env);
      },
    ];
    this.module.onRuntimeInitialized = () => mark('main');

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
      this.module.onEngineReady = () => {
        mark('ready');
        resolve();
      };
    });
    const factory = await Promise.race([
      loadEngineFactory(`${config.engineBase}engine.js`),
      failed,
    ]);
    mark('engine.js');
    await Promise.race([
      factory(this.module).then(
        () => {
          checkEngine(this.module);
          return ready;
        },
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
      if (
        PERMISSION_KINDS.includes(kind as PermissionKind) &&
        (value === 'grant' || value === 'deny')
      )
        module._bl_set_permission(this.text(kind), this.text(origin), value === 'grant' ? 1 : 2);
    this.screen.start(signal);
    for (const service of config.services) service.start(this.services.context);
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
    this.fullscreen.start(signal);
    this.network.start(signal);

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
      onEngineDownloadData: (id, bytes) => this.downloads.data(id, bytes),
      onEnginePrint: (view, bytes, title) =>
        this.views
          .get(view)
          ?.emit('print', { pdf: new Blob([bytes], { type: 'application/pdf' }), title }),
      onEngineIcon: (view, _url, mime, bytes) =>
        this.views.get(view)?.emit('icon', {
          blob: bytes.length ? new Blob([bytes], { type: mime || 'image/x-icon' }) : null,
        }),
      engineDialog: (dialog, view, type, origin, message, defaultValue) => {
        this.watchdog.answered();
        this.requests.dialog(dialog, this.views.get(view), type, origin, message, defaultValue);
      },
    };
    return module as EngineModule;
  }

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

  /** Takes an engine event away from the views; one handler per type. */
  handle<T>(type: string, handler: (data: T, view: ViewImpl | undefined, viewId: number) => void) {
    if (this.handlers.has(type)) throw new Error(`Engine event ${type} is handled twice`);
    this.handlers.set(type, handler as unknown as EventHandler);
  }

  private registerCoreEvents(): void {
    const withView =
      (fn: (view: ViewImpl, data: Record<string, unknown>) => void): EventHandler =>
      (data, view) => {
        if (view && !view.closed) fn(view, data);
      };
    this.handle('memory-pressure', () => this.events.emit('memory-pressure', {}));
    this.handle<Record<string, unknown>>('clipboard', (data) => {
      const write = this.config.handlers.clipboardWrite ?? writeHostClipboard;
      const request = { text: String(data.text ?? ''), html: String(data.html ?? '') };
      try {
        Promise.resolve(write(request)).catch((error: unknown) =>
          console.warn('[browser-lite] clipboardWrite failed:', error),
        );
      } catch (error) {
        console.warn('[browser-lite] clipboardWrite failed:', error);
      }
    });
    this.handle<Record<string, unknown>>('console', (data, view) => {
      const level = CONSOLE_LEVELS[Number(data.level)] ?? 'log';
      const message = String(data.message ?? '');
      const source = String(data.source ?? '');
      const line = Number(data.line) || 0;
      view?.emit('console', { level, message, source, line });
      if (this.config.debug)
        console[level](`[page ${view?.id ?? 0}] ${message}`, source ? `(${source}:${line})` : '');
    });
    this.handle<{ opener?: number }>('new-view', (data, _view, viewId) =>
      this.openEngineView(viewId, Number(data.opener)),
    );
    this.handle<Record<string, unknown>>('download-start', (data, view) =>
      this.downloads.start(data, view),
    );
    this.handle<Record<string, unknown>>('download-done', (data) => this.downloads.done(data));
    this.handle(
      'permission',
      withView((view, data) => {
        this.requests.permission(view, data as unknown as Parameters<Requests['permission']>[1]);
      }),
    );
    this.handle(
      'file-chooser',
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
      'color-picker',
      withView((view, data) => {
        this.requests.colorPicker(view, data);
      }),
    );
    this.handle(
      'date-time-picker',
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
  private openEngineView(id: number, openerId: number): void {
    const opener = this.views.get(openerId) ?? null;
    const view = this.addView(id, {}, true);
    if (this.events.has('new-view')) this.events.emit('new-view', { view, opener });
    else redirectPopup(view, opener);
  }

  private addView(id: number, options: ViewOptions, fromEngine: boolean): ViewImpl {
    const view = new ViewImpl(this, id, options, fromEngine);
    this.views.set(id, view);
    this.services.setupView(view);
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
    this.fullscreen.forget(view);
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
    this.services.gesture();
  }

  text(value: string | null | undefined): number {
    return this.module.stringToNewUTF8(value ?? '');
  }

  debugState(name: 'audio' | 'media' | 'rtc'): unknown {
    return this.services.debugState(name);
  }

  memoryPressure(): void {
    if (this.ready) this.events.emit('memory-pressure', {});
  }

  warn(code: WarningCode, message: string): void {
    console.warn(`[browser-lite] ${message}`);
    if (this.phase === 'starting') this.warnings.push([code, message]);
    else this.events.emit('warning', { code, message });
  }

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

  setPermission(origin: string, kind: PermissionKind, decision: PermissionDecision | null): void {
    const [checkedOrigin, checkedKind] = permissionChange(origin, kind, decision);
    storePermission(this.config.permissions, checkedOrigin, checkedKind, decision);
    if (this.ready)
      this.module._bl_set_permission(
        this.text(checkedKind),
        this.text(checkedOrigin),
        decision === 'grant' ? 1 : decision === 'deny' ? 2 : 0,
      );
  }

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
    this.downloads.abortAll();
    this.lifetime.abort();
    this.events.emit('crash', { reason });
  }

  async destroy(): Promise<void> {
    if (this.phase === 'destroyed') return;
    // An open dialog holds the engine thread: answer it so the engine can flush and close
    this.requests.closeDialogs();
    if (this.ready) this.storage.flush(500);
    this.watchdog.stop();
    this.requests.abortAll();
    this.downloads.abortAll();
    // While still ready, so the engine closes the pages too
    for (const view of [...this.views.values()]) view.dispose();
    this.phase = 'destroyed';
    this.failStart?.(new BrowserLiteError('destroyed', 'Destroyed while starting'));
    this.lifetime.abort();
    const module = this.module;
    try {
      module.blShutdown?.();
    } catch (error) {
      console.warn('[browser-lite] engine shutdown failed:', error);
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
