/**
 * Public types of the extensions of @browser-lite/core ([docs/extensions.md]). Semver-stable API
 * like `types.ts`.
 */
import type { Browser, RequestHandlers, Unsubscribe, View } from '../types.js';

/** Undoes what an extension set up. */
export type Disposer = () => void;

/** What a setup returns: nothing, or what undoes it. */
// biome-ignore lint/suspicious/noConfusingVoidType: setups usually return nothing
export type SetupResult = void | Disposer | Disposer[];

/**
 * An extension: a plain object, installed with {@link ExtensionHost.install}. `App` is what the
 * integrator offers its extensions ({@link ExtensionContext.app}), for example the UI slots of
 * `@browser-lite/ui`.
 */
export interface Extension<App = unknown> {
  /**
   * Unique id, `^[a-z0-9][a-z0-9._-]{0,63}$`. Names the storage of the extension and the
   * isolated world of its scripts.
   */
  readonly id: string;
  /** Version of the extension (for display; the host does not compare versions). */
  readonly version: string;
  /**
   * Runs at every enable (also right after install), not per browser. Everything registered
   * through the context ends at disable; disposers returned here run then too. A thrown error
   * (or rejection) leaves the extension disabled with {@link ExtensionInfo.error}.
   */
  setup(context: ExtensionContext<App>): SetupResult | Promise<SetupResult>;
}

/**
 * Joins the chain of a request handler: call `next()` for the answer of the rest of the chain
 * (later extensions, then the handler of {@link BrowserOptions.handlers}, then the default), or
 * answer without it.
 */
export type ChainedHandler<K extends keyof RequestHandlers> = (
  request: Parameters<RequestHandlers[K]>[0],
  next: () => ReturnType<RequestHandlers[K]>,
) => ReturnType<RequestHandlers[K]>;

/** Script for pages ({@link ExtensionContext.addScript}). */
export interface ContentScript {
  /**
   * Match patterns of the pages: `scheme://host/path` with `*` as scheme (http and https), as
   * host or its first label (`*.example.com`) and anywhere in the path, or `<all_urls>`.
   */
  matches: string[];
  /** Patterns of pages to leave out. */
  excludeMatches?: string[];
  /** JavaScript source. */
  code: string;
  /** Before the page's scripts or once the document is parsed (default). */
  runAt?: 'document-start' | 'document-end';
  /** Also into frames, not only the main frame. Default false. */
  allFrames?: boolean;
  /**
   * 'isolated' (default): a world of this extension, with the page's DOM but its own globals and
   * the global `extension` (sendMessage, onMessage). 'main': the page's own world, without it.
   */
  world?: 'isolated' | 'main';
}

/** CSS for pages ({@link ExtensionContext.addStyle}), a user style sheet like a browser's. */
export interface ContentStyle {
  /** Like {@link ContentScript.matches}. */
  matches: string[];
  excludeMatches?: string[];
  /** CSS source. Its `!important` rules win over those of the page. */
  code: string;
  /** Also into frames. Default false. */
  allFrames?: boolean;
}

/** Where a message of a script comes from ({@link ExtensionContext.onMessage}). */
export interface MessageSender {
  view: View;
  /** Address of the document of the frame that sent it. */
  url: string;
}

/**
 * Data of an extension that outlives a reload: synchronous reads, JSON values, saved through the
 * {@link ExtensionStore} of the host after every change. Meant for settings and small state.
 */
export interface ExtensionStorage {
  get<T = unknown>(key: string): T | undefined;
  /** Stores a JSON value; undefined deletes the key. */
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

/** Where the host keeps the data of each extension, for example the prefs of a profile. */
export interface ExtensionStore {
  /** Data of an extension, read before its setup; null when there is none. */
  load(id: string): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  /** All data of an extension after a change. */
  save(id: string, data: Record<string, unknown>): void | Promise<void>;
}

/** What an extension gets in its setup. Lives until the extension is disabled. */
export interface ExtensionContext<App = unknown> {
  readonly id: string;
  /** What the integrator offers ({@link ExtensionHostOptions.app}). */
  readonly app: App;
  /** Aborted when the extension is disabled or uninstalled. */
  readonly signal: AbortSignal;
  readonly storage: ExtensionStorage;
  /** The browser the host is attached to, null while there is none. */
  readonly browser: Browser | null;
  /**
   * Runs for the attached browser and every later one (a restart creates a new browser). What it
   * returns runs when the browser ends or the extension is disabled.
   */
  onBrowser(setup: (browser: Browser) => SetupResult): Disposer;
  /** Runs for every open and future view; what it returns runs when the view closes or at disable. */
  onView(setup: (view: View) => SetupResult): Disposer;
  /** Joins the chain of the request handler `type` (extensions in the order of installation). */
  handle<K extends keyof RequestHandlers>(type: K, handler: ChainedHandler<K>): Disposer;
  /** Runs a script in matching pages from their next document on. */
  addScript(script: ContentScript): Disposer;
  /** Adds CSS to matching pages, open ones included. */
  addStyle(style: ContentStyle): Disposer;
  /**
   * Answers `extension.sendMessage(message)` of the isolated scripts of this extension: the first
   * listener that returns something other than undefined (or a promise of it) answers, a thrown
   * error rejects. Messages are JSON values.
   */
  onMessage(listener: (message: unknown, sender: MessageSender) => unknown): Disposer;
  /** Sends a message to `extension.onMessage` of this extension's isolated scripts in the view. */
  postMessage(view: View, message: unknown): void;
}

/** Options of {@link createExtensionHost}. */
export interface ExtensionHostOptions<App> {
  /** Handed to every extension as {@link ExtensionContext.app}. */
  app?: App;
  /** Keeps {@link ExtensionContext.storage}; default in memory. */
  store?: ExtensionStore;
}

/** An installed extension ({@link ExtensionHost.extensions}). */
export interface ExtensionInfo {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  /** Why the last setup failed, null when it did not. */
  readonly error: unknown;
}

/**
 * The extensions of an integrator. Independent of a browser: pass it as
 * {@link BrowserOptions.extensions} to every browser it should serve (one at a time), so it
 * outlives restarts. Without extensions it costs nothing.
 */
export interface ExtensionHost<App = unknown> {
  /** Installed extensions in the order of installation. */
  readonly extensions: readonly ExtensionInfo[];
  /**
   * Installs and (unless `enabled: false`) enables an extension; resolves once its setup ran.
   * Install before `createBrowser` so its scripts reach the first page.
   * @throws BrowserLiteError `invalid-options` for an invalid or taken id.
   */
  install(extension: Extension<App>, options?: { enabled?: boolean }): Promise<void>;
  /** Disables and removes an extension; its stored data stays. */
  uninstall(id: string): Promise<void>;
  /** Runs the setup again; resolves when done. */
  enable(id: string): Promise<void>;
  /** Undoes everything the extension set up. */
  disable(id: string): Promise<void>;
  /** An extension was installed, uninstalled, enabled or disabled, or its setup failed. */
  on(type: 'change', listener: () => void): Unsubscribe;
}
