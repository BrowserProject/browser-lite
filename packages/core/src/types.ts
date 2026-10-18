/**
 * Public types of @browser-lite/core. The implementation lives in the other modules of this
 * package; everything here is semver-stable API.
 */

/** Unsubscribes a listener registered with `on()`. */
export type Unsubscribe = () => void;

/** Codes of {@link BrowserLiteError}. */
export type ErrorCode =
  | 'unsupported'
  | 'not-cross-origin-isolated'
  | 'engine-load-failed'
  | 'already-running'
  | 'invalid-options'
  | 'storage-locked'
  | 'destroyed'
  | 'crashed';

/** Result of {@link checkSupport}. */
export interface SupportReport {
  /** True when every required host browser feature is present. */
  supported: boolean;
  /** Names of missing features, for example `crossOriginIsolated` or `OffscreenCanvas`. */
  missing: string[];
}

/** Why a TCP stream of a {@link Transport} closed. */
export type CloseReason =
  | 'closed'
  | 'reset'
  | 'refused'
  | 'unreachable'
  | 'name-not-resolved'
  | 'timeout'
  | 'blocked'
  | 'throttled'
  | 'invalid'
  | 'transport-down';

/** One TCP connection opened through a {@link Transport}. */
export interface TransportStream {
  /** Sends bytes; the transport takes ownership of `data`. */
  send(data: Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  ondata: ((data: Uint8Array) => void) | null;
  /** Bytes handed to the network since the last call (flow control). */
  onsent: ((bytes: number) => void) | null;
  onclose: ((reason: CloseReason) => void) | null;
}

/**
 * Network of the engine: TCP connections to host:port (TLS happens inside the engine).
 * Dispatches the event `connectedchange` when `connected` changes.
 */
export interface Transport extends EventTarget {
  readonly connected: boolean;
  openTCP(host: string, port: number): TransportStream;
}

/** A host service (audio, media, capture, ...). Created by the factory functions only. */
export interface HostService {
  readonly name: string;
}

/** Back/forward list of a view. */
export interface SessionHistory {
  index: number;
  entries: { url: string; title: string }[];
}

/** Rectangle in CSS pixels relative to the view canvas. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Emulated device screen. */
export interface DeviceOptions {
  /** Screen size in CSS pixels; the view keeps at most this size. */
  width: number;
  height: number;
  pixelRatio: number;
  /** Touch screen (navigator.maxTouchPoints, touch events). Default true. */
  touch?: boolean;
  /** Mobile device: coarse pointer without hover. Default true. */
  mobile?: boolean;
}

/** Page settings that apply to all views. */
export interface Preferences {
  javascript?: boolean;
  images?: boolean;
  globalPrivacyControl?: boolean;
}

/** Storage of the pages (cookies, localStorage, IndexedDB, caches). */
export interface StorageOptions {
  /** False keeps everything in memory only. Default true (origin private file system). */
  persistent?: boolean;
  /**
   * OPFS subdirectory and prefix of caches and locks, `^[a-z0-9_]{1,32}$`.
   * Default `browserlite`. Only one running browser per namespace (all tabs of the origin).
   */
  namespace?: string;
  /** Runs before the engine starts, with the namespace directory (for example a profile download). */
  beforeStart?: (directory: FileSystemDirectoryHandle) => Promise<void>;
}

/** Service worker that serves media files to `<video>` and `<audio>`. */
export type ServiceWorkerOption =
  | { registration: ServiceWorkerRegistration }
  | { url: string | URL; scope?: string };

/** Switches of the engine. */
export interface EngineOptions {
  /** Paint with WebGL 2 (default true). */
  gpu?: boolean;
  /** Composited layers (default true with gpu). */
  compositing?: boolean;
  /** Garbage collection at safe points; 'debug' logs it. */
  safepointGC?: boolean | 'debug';
  /** Persistent HTTP cache (default true). */
  httpCache?: boolean;
  /** Seconds before a long running script is stopped. */
  scriptTimeoutSeconds?: number;
  /** Extra CA certificates (PEM) for TLS inside the engine. */
  extraCA?: string;
  /** Engine log in the console. */
  log?: boolean;
  /**
   * Expert switches (`BL_*`, `JSC_*`, `FC_*`). Not covered by semver; keys owned by the core
   * are rejected.
   * @experimental
   */
  env?: Record<string, string>;
}

/** Options of {@link createBrowser}. */
export interface BrowserOptions {
  /** Folder URL with engine.js, engine.wasm and engine.data. Must be same-origin. */
  engineUrl: string | URL;
  /** Network of the engine, for example a `WispTransport`. */
  transport: Transport;
  storage?: StorageOptions;
  /** Needed for media files in `<video>`/`<audio>`; never registered implicitly. */
  serviceWorker?: ServiceWorkerOption;
  /** Host services; default {@link defaultServices}. */
  services?: HostService[];
  /** Answers to requests of the engine; missing ones get safe defaults. */
  handlers?: Partial<RequestHandlers>;
  /** Remembered permission decisions; default in memory. */
  permissions?: PermissionStore;
  /** HTML template of the error page (placeholders documented in engine/README.md). */
  errorPage?: string;
  userAgent?: string;
  /** navigator.platform */
  platform?: string;
  /** navigator.languages and Accept-Language; default the host languages. */
  languages?: string[];
  /** IANA time zone; default the host time zone. */
  timeZone?: string;
  /** Default 'system' (follows the host). */
  colorScheme?: ColorScheme;
  /** Emulated device; default the host screen. */
  device?: DeviceOptions;
  preferences?: Preferences;
  /** Keep session cookies over restarts (like restoring a session). Default false. */
  keepSessionCookies?: boolean;
  engine?: EngineOptions;
  /** Enables `browser.debug` and the engine test hooks. Never with foreign scripts on the page. */
  debug?: boolean;
}

export type ColorScheme = 'light' | 'dark' | 'system';

/** The running engine. One per page at a time. */
export interface Browser {
  readonly state: 'ready' | 'crashed' | 'destroyed';
  /** Open views by id. */
  readonly views: ReadonlyMap<number, View>;
  createView(options?: ViewOptions): View;
  on<K extends keyof BrowserEvents>(
    type: K,
    listener: (event: BrowserEvents[K]) => void,
  ): Unsubscribe;
  setColorScheme(scheme: ColorScheme): void;
  setLanguages(languages: string[]): void;
  setUserAgent(userAgent: string, platform?: string): void;
  setPreferences(preferences: Preferences): void;
  readonly storage: BrowserStorage;
  /** Only with `debug: true`. */
  readonly debug?: DebugApi;
  /** Stops the engine and frees its workers, memory, canvases and lock. */
  destroy(): Promise<void>;
}

export interface BrowserStorage {
  readonly persistent: boolean;
  /** OPFS namespace directory, null when memory only. Read only while running. */
  readonly directory: FileSystemDirectoryHandle | null;
  /** Writes pending databases now; waitMs > 0 blocks up to that long (page hide). */
  flush(waitMs?: number): void;
  /** Clears the HTTP cache and the bytecode cache of this namespace. */
  clearCaches(): Promise<void>;
}

export interface BrowserEvents {
  /** window.open or target=_blank: the engine already created the view. */
  'new-view': { view: View; opener: View | null };
  /** A download started; without any listener the file is saved automatically when done. */
  download: { download: Download };
  /** The engine's memory grows: close or discard background views. */
  'memory-pressure': Record<string, never>;
  /** No answer from the engine for 10 s after input. */
  unresponsive: Record<string, never>;
  responsive: Record<string, never>;
  /** The engine stopped; create a new browser (or reload the page). */
  crash: { reason: string };
  /** Network of the pages (host online and transport connected). */
  network: { connected: boolean };
  warning: { code: WarningCode; message: string };
}

export type WarningCode = 'storage-locked' | 'media-sw-missing';

/** Options of {@link Browser.createView}. */
export interface ViewOptions {
  url?: string;
  html?: { html: string; baseURL: string };
  /** Restores back/forward and loads the current entry. */
  history?: SessionHistory;
  /** Element the view fills; canvas and IME field are created inside. */
  container?: HTMLElement;
  /** Default true. */
  visible?: boolean;
  /** Default 1. */
  zoom?: number;
}

/** One page (tab or popup). */
export interface View {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly history: SessionHistory | null;
  readonly zoom: number;
  readonly muted: boolean;
  readonly audible: boolean;
  readonly closed: boolean;
  readonly canvas: HTMLCanvasElement;
  on<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): Unsubscribe;
  attach(container: HTMLElement): void;
  detach(): void;
  load(url: string): void;
  loadHTML(html: string, baseURL: string): void;
  reload(): void;
  stop(): void;
  back(): void;
  forward(): void;
  restoreHistory(history: SessionHistory): void;
  setVisible(visible: boolean): void;
  /** Keyboard focus into the page. */
  focus(): void;
  /** Moves focus to the first (forward) or last element, like Tab from outside. */
  focusFirstElement(forward: boolean): void;
  setZoom(zoom: number): void;
  setMuted(muted: boolean): void;
  find(text: string, options?: { backwards?: boolean; again?: boolean }): void;
  stopFind(): void;
  /** Builds a PDF; delivered with the event `print`. */
  print(): void;
  /** Loads the page source; delivered with the event `source`. */
  viewSource(): void;
  command(name: EditCommand): void;
  /** Puts text on the engine clipboard and pastes it. */
  paste(text: string): void;
  exitFullscreen(): void;
  /** Runs beforeunload unless `force`; resolves true when the view closed. */
  close(options?: { force?: boolean }): Promise<boolean>;
}

export type EditCommand = 'Copy' | 'Cut' | 'Paste' | 'SelectAll' | 'Undo' | 'Redo';

export interface ViewEvents {
  navigation: {
    url: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
    history: SessionHistory | null;
  };
  title: { title: string; url: string };
  progress: { value: number };
  /** The zoom changed (setZoom or Ctrl + mouse wheel over the page). */
  zoom: { zoom: number };
  /** A new document; `errorPage` is the kind of error page (for example 'certificate') or null. */
  commit: { errorPage: string | null };
  load: Record<string, never>;
  error: { description: string };
  'first-layout': Record<string, never>;
  'first-paint': Record<string, never>;
  console: {
    level: 'log' | 'warn' | 'error' | 'debug' | 'info';
    message: string;
    source: string;
    line: number;
  };
  icon: { blob: Blob | null };
  hover: { url: string | null };
  find: { matches: number; index: number };
  fullscreen: { active: boolean };
  'media-state': { audible: boolean };
  'capture-state': { active: boolean };
  'beforeunload-state': { hasListener: boolean };
  /** Click, key, text or paste into the page (until the next document). */
  'user-activation': Record<string, never>;
  /** Ctrl/middle click on a link. */
  'open-tab': { url: string };
  /** mailto:, tel: and app links. */
  'external-url': { url: string };
  /** window.focus() */
  'focus-request': Record<string, never>;
  /** Tab moved focus past the first or last element of the page. */
  'take-focus': { forward: boolean };
  'context-menu': ContextMenuInfo;
  print: { pdf: Blob; title: string };
  source: { url: string; text: string };
  close: Record<string, never>;
}

export interface ContextMenuInfo {
  /** Position in CSS pixels relative to the view canvas. */
  x: number;
  y: number;
  link: string;
  image: string;
  selection: string;
  editable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Requests the engine waits for. Each has exactly one handler. */
export interface RequestHandlers {
  /**
   * alert, confirm, prompt and beforeunload. SYNCHRONOUS: the engine waits. Return value:
   * confirm -> boolean, prompt -> string or null, beforeunload -> true to leave.
   * Default: alert ignored, confirm false, prompt null, beforeunload true.
   */
  dialog(request: DialogRequest): boolean | string | null | undefined;
  /** Default 'deny'. */
  permission(request: PermissionRequest): Promise<'grant' | 'deny'>;
  /** Default: the native file dialog of the host browser. */
  fileChooser(request: FileChooserRequest): Promise<File[] | null>;
  /** `<select>` popup; resolves the chosen index or -1. Default -1. */
  selectPopup(request: SelectRequest): Promise<number>;
  /** `<input type=color>`; resolves a #rrggbb value or null. Default null. */
  colorPicker(request: ColorRequest): Promise<string | null>;
  /** Date and time inputs; resolves the value string or null. Default null. */
  dateTimePicker(request: DateTimeRequest): Promise<string | null>;
}

export interface DialogRequest {
  view: View;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  origin: string;
  message: string;
  defaultValue: string;
  /** beforeunload of a reload. */
  reload: boolean;
}

export interface PermissionRequest {
  view: View;
  /** For example 'geolocation', 'notifications', 'camera', 'microphone'. */
  kind: string;
  origin: string;
  signal: AbortSignal;
}

export interface FileChooserRequest {
  view: View;
  multiple: boolean;
  /** Value of the accept attribute. */
  accept: string;
  signal: AbortSignal;
}

export interface SelectItem {
  text: string;
  tooltip: string;
  enabled: boolean;
  /** Group label (optgroup). */
  label: boolean;
  selected: boolean;
  separator: boolean;
}

export interface SelectRequest {
  view: View;
  rect: Rect;
  items: SelectItem[];
  selectedIndex: number;
  /** Aborted when the page hides the popup, the view closes or the engine stops. */
  signal: AbortSignal;
}

export interface ColorRequest {
  view: View;
  rect: Rect;
  value: string;
  signal: AbortSignal;
  /** Shows a value in the page while the picker is open (live preview). */
  preview(value: string): void;
}

export interface DateTimeRequest {
  view: View;
  rect: Rect;
  /** Input type: date, time, datetime-local, month, week. */
  type: string;
  value: string;
  /** Like valueAsNumber; 0 when not set. */
  min: number;
  max: number;
  step: number;
  signal: AbortSignal;
  /** Shows a value in the page while the picker is open (live preview). */
  preview(value: string): void;
}

/** Remembered permission decisions per origin. */
export interface PermissionStore {
  get(origin: string, kind: string): 'grant' | 'deny' | undefined;
  set(origin: string, kind: string, value: 'grant' | 'deny'): void;
  entries(): Iterable<[origin: string, kind: string, value: 'grant' | 'deny']>;
}

/** A download of the pages. */
export interface Download {
  readonly id: number;
  readonly filename: string;
  readonly mime: string;
  /** Address the file came from. */
  readonly url: string;
  /** Expected size in bytes, 0 when unknown. */
  readonly size: number;
  readonly received: number;
  readonly state: 'progress' | 'done' | 'failed';
  readonly error?: string;
  /** The file once done. */
  readonly blob: Blob | null;
  on(type: 'progress' | 'done' | 'error', listener: () => void): Unsubscribe;
  /** Saves the file with the download of the host browser. */
  save(): void;
}

/** Debug and test access, only with `debug: true`. */
export interface DebugApi {
  /** The raw Emscripten module (for DevTools only, not stable). */
  readonly module: unknown;
  /** Runs JavaScript in the page; the result goes to the console as [eval]. */
  eval(view: View, source: string): void;
  /** Size of the engine memory; a report level writes a report to the console. */
  memory(report?: 0 | 1 | 2 | 3): number;
  /** Color at a CSS pixel of the visible page. */
  pagePixel(view: View, x: number, y: number): [number, number, number];
  pageRow(view: View, y: number): [number, number, number][];
  audioState(): unknown;
  mediaState(): unknown;
  rtcState(): unknown;
  /** Behaves like a memory-pressure message of the engine. */
  memoryPressure(): void;
}
