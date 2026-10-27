import { Emitter } from '../emitter.js';
import { BrowserLiteError } from '../errors.js';
import { isRequestType } from '../handlers.js';
import type { Browser, RequestHandlers, Unsubscribe, View } from '../types.js';
import { type EngineScript, type EngineStyle, engineScript, engineStyle } from './content.js';
import {
  ATTACH,
  type AttachableHost,
  type ExtensionBrowser,
  type ExtensionLink,
  type ScriptMessage,
} from './link.js';
import { MemoryExtensionStore, ScopedStorage } from './storage.js';
import type {
  ChainedHandler,
  ContentScript,
  ContentStyle,
  Disposer,
  Extension,
  ExtensionContext,
  ExtensionHost,
  ExtensionHostOptions,
  ExtensionInfo,
  ExtensionStore,
  MessageSender,
  SetupResult,
} from './types.js';

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type MessageListener = (message: unknown, sender: MessageSender) => unknown;
type AnyChained = ChainedHandler<keyof RequestHandlers>;

const warn = (id: string, what: string, error: unknown) =>
  console.warn(`[browser-lite] extension ${id}: ${what}:`, error);

/** The functions of a setup's result. */
const disposersOf = (result: unknown): Disposer[] =>
  [result].flat().filter((item): item is Disposer => typeof item === 'function');

/** A setup that runs once per target (browser or view) and keeps the disposers of each run. */
class Hook<T> {
  private readonly runs = new Map<T, Disposer[]>();

  constructor(
    private readonly id: string,
    private readonly setup: (target: T) => SetupResult,
  ) {}

  run(target: T): void {
    if (this.runs.has(target)) return;
    this.runs.set(target, []);
    try {
      this.runs.set(target, disposersOf(this.setup(target)));
    } catch (error) {
      warn(this.id, 'setup failed', error);
    }
  }

  end(target: T): void {
    const disposers = this.runs.get(target) ?? [];
    this.runs.delete(target);
    for (const disposer of disposers.reverse()) safely(this.id, disposer);
  }

  endAll(): void {
    for (const target of [...this.runs.keys()]) this.end(target);
  }
}

function safely(id: string, disposer: Disposer): void {
  try {
    disposer();
  } catch (error) {
    warn(id, 'dispose failed', error);
  }
}

/** What one enable of an extension registered; all of it ends at disable. */
class Activation {
  readonly controller = new AbortController();
  readonly disposers: Disposer[] = [];
  readonly handlers = new Map<keyof RequestHandlers, AnyChained[]>();
  readonly scripts = new Set<EngineScript>();
  readonly styles = new Set<EngineStyle>();
  readonly listeners = new Set<MessageListener>();
  readonly browserHooks = new Set<Hook<Browser>>();
  readonly viewHooks = new Set<Hook<View>>();

  get ended(): boolean {
    return this.controller.signal.aborted;
  }
}

interface Installed {
  readonly extension: Extension<never>;
  active: Activation | null;
  error: unknown;
  /** Enable and disable one after the other. */
  queue: Promise<void>;
}

class ExtensionHostImpl<App> implements ExtensionHost<App>, AttachableHost {
  private readonly installed = new Map<string, Installed>();
  private readonly events = new Emitter<{ change: Record<string, never> }>();
  private readonly app: App;
  private readonly store: ExtensionStore;
  private attached: ExtensionBrowser | null = null;
  private readonly views = new Set<View>();
  /** Content the engine has, '[]' until something was sent. */
  private sentContent = '[]';
  private contentQueued = false;

  constructor(options: ExtensionHostOptions<App>) {
    this.app = options.app as App;
    this.store = options.store ?? new MemoryExtensionStore();
  }

  get extensions(): ExtensionInfo[] {
    return [...this.installed.values()].map(({ extension, active, error }) => ({
      id: extension.id,
      version: extension.version,
      enabled: !!active,
      error,
    }));
  }

  async install(extension: Extension<App>, options?: { enabled?: boolean }): Promise<void> {
    const { id, version, setup } = (extension ?? {}) as Partial<Extension<App>>;
    if (typeof id !== 'string' || !ID.test(id))
      throw new BrowserLiteError('invalid-options', `Invalid extension id: ${String(id)}`);
    if (typeof version !== 'string' || typeof setup !== 'function')
      throw new BrowserLiteError('invalid-options', `Extension ${id} needs a version and setup()`);
    if (this.installed.has(id))
      throw new BrowserLiteError('invalid-options', `Extension ${id} is already installed`);
    this.installed.set(id, {
      extension: extension as Extension<never>,
      active: null,
      error: null,
      queue: Promise.resolve(),
    });
    this.changed();
    if (options?.enabled !== false) await this.enable(id);
  }

  async uninstall(id: string): Promise<void> {
    const entry = this.installed.get(id);
    if (!entry) return;
    await this.disable(id);
    if (this.installed.get(id) !== entry) return;
    this.installed.delete(id);
    this.changed();
  }

  enable(id: string): Promise<void> {
    return this.queue(id, (entry) => this.activate(entry));
  }

  disable(id: string): Promise<void> {
    return this.queue(id, async (entry) => {
      if (this.deactivate(entry)) this.changed();
    });
  }

  on(type: 'change', listener: () => void): Unsubscribe {
    return this.events.on(type, listener);
  }

  private queue(id: string, step: (entry: Installed) => Promise<void>): Promise<void> {
    const entry = this.installed.get(id);
    if (!entry)
      return Promise.reject(new BrowserLiteError('invalid-options', `No extension ${id}`));
    entry.queue = entry.queue.then(() =>
      this.installed.get(id) === entry ? step(entry) : undefined,
    );
    return entry.queue;
  }

  private changed(): void {
    this.events.emit('change', {});
  }

  private async activate(entry: Installed): Promise<void> {
    if (entry.active) return;
    const { id } = entry.extension;
    let data: Record<string, unknown> | null = null;
    try {
      data = await this.store.load(id);
    } catch (error) {
      warn(id, 'loading its data failed', error);
    }
    const active = new Activation();
    entry.active = active;
    entry.error = null;
    const context = this.context(id, active, new ScopedStorage(id, this.store, { ...data }));
    try {
      const result = await entry.extension.setup(context as ExtensionContext<never>);
      active.disposers.push(...disposersOf(result));
    } catch (error) {
      warn(id, 'setup failed', error);
      this.deactivate(entry);
      entry.error = error;
    }
    this.changed();
  }

  private deactivate(entry: Installed): boolean {
    const active = entry.active;
    if (!active) return false;
    const { id } = entry.extension;
    entry.active = null;
    active.controller.abort();
    for (const hook of active.viewHooks) hook.endAll();
    for (const hook of active.browserHooks) hook.endAll();
    for (const disposer of active.disposers.reverse()) safely(id, disposer);
    active.handlers.clear();
    active.listeners.clear();
    if (active.scripts.size || active.styles.size) {
      active.scripts.clear();
      active.styles.clear();
      this.queueContent();
    }
    return true;
  }

  private context(id: string, active: Activation, storage: ScopedStorage): ExtensionContext<App> {
    const host = this;
    // Registrations after the end of the activation do nothing
    const register = <T>(set: Set<T>, value: T, after?: () => void): Disposer => {
      if (active.ended) return () => {};
      set.add(value);
      after?.();
      return () => {
        if (set.delete(value)) after?.();
      };
    };
    return {
      id,
      app: this.app,
      signal: active.controller.signal,
      storage,
      get browser() {
        return host.attached?.browser ?? null;
      },
      onBrowser(setup) {
        const hook = new Hook(id, setup);
        const dispose = register(active.browserHooks, hook);
        if (!active.ended && host.attached) hook.run(host.attached.browser);
        return () => {
          dispose();
          hook.endAll();
        };
      },
      onView(setup) {
        const hook = new Hook(id, setup);
        const dispose = register(active.viewHooks, hook);
        if (!active.ended) for (const view of host.views) hook.run(view);
        return () => {
          dispose();
          hook.endAll();
        };
      },
      handle(type, handler) {
        if (!isRequestType(type))
          throw new BrowserLiteError('invalid-options', `Unknown request type: ${String(type)}`);
        if (typeof handler !== 'function')
          throw new BrowserLiteError(
            'invalid-options',
            `The handler of ${String(type)} must be a function`,
          );
        if (active.ended) return () => {};
        const link = handler as unknown as AnyChained;
        const chain = active.handlers.get(type) ?? [];
        active.handlers.set(type, chain);
        chain.push(link);
        return () => {
          const index = chain.indexOf(link);
          if (index >= 0) chain.splice(index, 1);
        };
      },
      addScript(script: ContentScript) {
        return register(active.scripts, engineScript(script), () => host.queueContent());
      },
      addStyle(style: ContentStyle) {
        return register(active.styles, engineStyle(style), () => host.queueContent());
      },
      onMessage(listener) {
        return register(active.listeners, listener);
      },
      postMessage(view, message) {
        if (active.ended || view.closed) return;
        host.attached?.postMessage(view, id, JSON.stringify(message ?? null));
      },
    };
  }

  // ------------------------------------------------------------ The attached browser

  /** Handlers of the enabled extensions for a request, in the order of installation. */
  private chain<K extends keyof RequestHandlers>(type: K): ChainedHandler<K>[] {
    const result: AnyChained[] = [];
    for (const { active } of this.installed.values())
      if (active) result.push(...(active.handlers.get(type) ?? []));
    return result as unknown as ChainedHandler<K>[];
  }

  private queueContent(): void {
    if (this.contentQueued || !this.attached) return;
    this.contentQueued = true;
    queueMicrotask(() => {
      this.contentQueued = false;
      this.sendContent();
    });
  }

  /** Sends the content of the enabled extensions when it changed; nothing while there is none. */
  private sendContent(): void {
    if (!this.attached) return;
    const content = [];
    for (const { extension, active } of this.installed.values())
      if (active && (active.scripts.size || active.styles.size))
        content.push({
          extension: extension.id,
          scripts: [...active.scripts],
          styles: [...active.styles],
        });
    const json = JSON.stringify(content);
    if (json === this.sentContent) return;
    this.sentContent = json;
    this.attached.setContent(json);
  }

  private activeHooks<T extends 'browserHooks' | 'viewHooks'>(kind: T): Activation[T][] {
    const result: Activation[T][] = [];
    for (const { active } of this.installed.values()) if (active) result.push(active[kind]);
    return result;
  }

  private viewAdded(view: View): void {
    if (this.views.has(view) || view.closed) return;
    this.views.add(view);
    view.on('close', () => {
      this.views.delete(view);
      for (const hooks of this.activeHooks('viewHooks')) for (const hook of hooks) hook.end(view);
    });
    for (const hooks of this.activeHooks('viewHooks')) for (const hook of hooks) hook.run(view);
  }

  private async message(data: ScriptMessage, view: View): Promise<unknown> {
    const active = this.installed.get(data.extension)?.active;
    if (!active)
      throw new BrowserLiteError('invalid-options', `Extension ${data.extension} is not enabled`);
    const message = JSON.parse(data.message) as unknown;
    const sender = { view, url: data.url };
    for (const listener of [...active.listeners]) {
      const answer = await listener(message, sender);
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  private detach(browser: ExtensionBrowser): void {
    if (this.attached !== browser) return;
    for (const hooks of this.activeHooks('viewHooks')) for (const hook of hooks) hook.endAll();
    for (const hooks of this.activeHooks('browserHooks'))
      for (const hook of hooks) hook.end(browser.browser);
    this.views.clear();
    this.attached = null;
    this.sentContent = '[]';
  }

  [ATTACH](browser: ExtensionBrowser): ExtensionLink {
    if (this.attached)
      throw new BrowserLiteError('invalid-options', 'The extension host serves another browser');
    this.attached = browser;
    // Before the first view, so its first document gets the scripts
    this.sendContent();
    for (const hooks of this.activeHooks('browserHooks'))
      for (const hook of hooks) hook.run(browser.browser);
    for (const view of browser.views()) this.viewAdded(view);
    return {
      handlers: (type) => this.chain(type),
      viewAdded: (view) => this.viewAdded(view),
      message: (data, view) => this.message(data, view),
      detach: () => this.detach(browser),
    };
  }
}

/**
 * Creates the host of an integrator's extensions; pass it as `extensions` to `createBrowser`.
 * Installing works before and after the start, also across restarts of the browser.
 */
export function createExtensionHost<App = undefined>(
  options: ExtensionHostOptions<App> = {},
): ExtensionHost<App> {
  return new ExtensionHostImpl(options);
}
