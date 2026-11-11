/**
 * Public types of @browser-lite/core. The implementation lives in the other modules of this
 * package; everything here is semver-stable API.
 */

import type { ExtensionHost } from './extensions/types.js';

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

/** Host browser features the engine needs; {@link checkSupport} reports the missing ones. */
export type SupportFeature =
  | 'document'
  | 'crossOriginIsolated'
  | 'SharedArrayBuffer'
  | 'Atomics'
  | 'Worker'
  | 'WebAssembly'
  | 'WebAssembly threads'
  | 'ResizeObserver';

/** Result of {@link checkSupport}. */
export interface SupportReport {
  /** True when every required host browser feature is present. */
  supported: boolean;
  /** The missing features. */
  missing: SupportFeature[];
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
 * Dispatches the event `connectedchange` when `connected` changes. Unlike the `on()` events of
 * browsers and views this is a plain EventTarget, so a transport needs no code of the core.
 * The integrator owns it: the browser never closes it, `destroy()` leaves it open.
 */
export interface Transport extends EventTarget {
  /** False while the network of the transport is down (pages see `navigator.onLine` false). */
  readonly connected: boolean;
  /** Opens a TCP connection to host:port. */
  openTCP(host: string, port: number): TransportStream;
  /**
   * Optional: starts connecting ahead of the first `openTCP`. `createBrowser` calls it when the
   * engine files start loading, so the first page does not wait for the transport's handshake.
   */
  preconnect?(): void;
}

/** A host service (audio, media, capture, ...). Created by the factory functions only. */
export interface HostService {
  readonly name: string;
}

/** Back/forward list of a view. */
export interface SessionHistory {
  /** Position of the current entry in `entries` (from 0). */
  index: number;
  /**
   * `scrollX`/`scrollY`: where the page of the entry was scrolled to (main frame, in pixels),
   * where it comes back to after `restoreHistory`; 0 when absent.
   */
  entries: { url: string; title: string; scrollX?: number; scrollY?: number }[];
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
  /** Screen size in CSS pixels; the view keeps at most this size ({@link Browser.setDevice} changes it). */
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
  /**
   * Data saver: every request carries `Save-Data: on` and `navigator.connection.saveData` is
   * true, so sites that honour it send lighter pages and images. Default false.
   */
  saveData?: boolean;
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
  /**
   * Seconds input or a call may wait for a script that blocks the engine before the engine stops
   * it (default 30, 0 = never). A script nobody waits for runs to its end.
   */
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
  /**
   * Answers to requests of the engine; missing ones get safe defaults. Handlers of extensions
   * run before these ({@link ChainedHandler}).
   */
  handlers?: Partial<RequestHandlers>;
  /**
   * Extensions of {@link createExtensionHost}: one host serves one browser at a time and stays
   * across restarts. Without it, or without extensions, nothing of them runs.
   */
  extensions?: ExtensionHost<unknown>;
  /** Remembered permission decisions; default in memory. */
  permissions?: PermissionStore;
  /**
   * HTML template of the error page shown for a failed main frame navigation. Placeholders, all
   * HTML-escaped: `{{lang}}`, `{{kind}}` (`network`, `certificate` or `http`), `{{title}}`
   * (the host), `{{heading}}`, `{{message}}`, `{{code}}` (for example `ERR_NAME_NOT_RESOLVED`),
   * `{{url}}` and `{{retryLabel}}`. A click on a `[data-bl-retry]` element retries. The page
   * runs without scripts and external resources (inline styles and `data:` images only).
   */
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
  /**
   * Highest pixel ratio the pages render at (at least 1), see {@link Browser.setMaxPixelRatio}.
   * Default: no limit.
   */
  maxPixelRatio?: number;
  preferences?: Preferences;
  /** Keep session cookies over restarts (like restoring a session). Default false. */
  keepSessionCookies?: boolean;
  engine?: EngineOptions;
  /**
   * Progress of the start for a loading indicator: the download of the engine files (only when
   * they do not come from the cache), then `phase: 'start'` once they are there.
   */
  onProgress?: (progress: StartProgress) => void;
  /** Enables `browser.debug` and the engine test hooks. Never with foreign scripts on the page. */
  debug?: boolean;
}

/** Color scheme of the pages; 'system' follows the host. */
/** See {@link BrowserOptions.onProgress}. */
export interface StartProgress {
  /** 'download' while engine.wasm and engine.data load, 'start' once they are there. */
  phase: 'download' | 'start';
  /** Bytes of engine.wasm and engine.data received, uncompressed. */
  loaded: number;
  /** Their size (from manifest.json next to the engine), 0 while unknown. */
  total: number;
}

export type ColorScheme = 'light' | 'dark' | 'system';

/** The running engine. One per page at a time. */
export interface Browser {
  /** 'crashed' after the event `crash`, 'destroyed' after `destroy()`. */
  readonly state: 'ready' | 'crashed' | 'destroyed';
  /** Network of the pages: host online and transport connected (event `network`). */
  readonly online: boolean;
  /** Open views by id. */
  readonly views: ReadonlyMap<number, View>;
  /** Opens a view (tab); without `container` it stays hidden until {@link View.attach}. */
  createView(options?: ViewOptions): View;
  on<K extends keyof BrowserEvents>(
    type: K,
    listener: (event: BrowserEvents[K]) => void,
  ): Unsubscribe;
  setColorScheme(scheme: ColorScheme): void;
  /** navigator.languages and Accept-Language of the pages. */
  setLanguages(languages: string[]): void;
  /**
   * Connects to the origin of an http(s) address ahead (TCP through the transport and TLS), for
   * example while the user types it into an address bar, so loading it saves those round trips.
   * Other schemes and repeats within 10 s do nothing.
   */
  preconnect(url: string): void;
  /**
   * Addresses that count as visited for the `:visited` style of links, for example those of the
   * host's own history after the start; the addresses the views load count without this. Open
   * pages restyle their links to them. Like in other browsers pages cannot read the result.
   */
  addVisitedLinks(urls: string[]): void;
  /** No link counts as visited any more, for example after the user cleared the history. */
  clearVisitedLinks(): void;
  /**
   * Highest pixel ratio the pages render at on the host screen (at least 1), null for no limit;
   * an emulated device keeps its own. On a screen with a higher pixel ratio the host scales the
   * views up: slightly softer, but the engine paints fewer pixels (a quarter at ratio 2 with
   * limit 1), and pages pick smaller images.
   */
  setMaxPixelRatio(limit: number | null): void;
  /**
   * Changes the emulated device at runtime (null: the host screen), for example its size after
   * the phone was rotated: the views keep at most the new size and lay out again, `screen`,
   * `screen.orientation` (with its `change` event) and the media queries of size, pointer and
   * hover follow. The pixel ratio follows too; the user agent stays (see {@link setUserAgent}).
   */
  setDevice(device: DeviceOptions | null): void;
  /** navigator.userAgent and navigator.platform; empty strings mean the engine default. */
  setUserAgent(userAgent: string, platform?: string): void;
  /** Changes some preferences; the others keep their value. */
  setPreferences(preferences: Preferences): void;
  /**
   * Changes or forgets (null) a remembered permission decision, for example from a settings
   * page. Writes the {@link PermissionStore} and applies at once; null means the page asks again.
   */
  setPermission(origin: string, kind: PermissionKind, decision: PermissionDecision | null): void;
  /**
   * After `unresponsive`, when the user chose to wait: the engine gives the script that blocks it
   * the whole `scriptTimeoutSeconds` again, and `unresponsive` comes again if the engine still
   * does not answer 10 s later. Does nothing while the engine answers.
   */
  keepWaiting(): void;
  readonly storage: BrowserStorage;
  /** Only with `debug: true`. */
  readonly debug?: DebugApi;
  /**
   * Stops the engine and frees its workers, memory, canvases and lock. Running downloads end
   * with an error. The transport stays open: close it too (`transport.close()` of a
   * `WispTransport`) unless the next browser reuses it.
   */
  destroy(): Promise<void>;
}

/** Storage of a running browser. */
export interface BrowserStorage {
  readonly persistent: boolean;
  /** OPFS namespace directory, null when memory only. Read only while running. */
  readonly directory: FileSystemDirectoryHandle | null;
  /**
   * Writes pending databases now; waitMs > 0 blocks up to that long (page hide). Only Chromium
   * lets the engine write while the main thread waits; elsewhere the writing goes on after it.
   */
  flush(waitMs?: number): void;
  /** Clears the HTTP cache of this namespace. */
  clearCaches(): Promise<void>;
}

/** Events of {@link Browser.on}. */
export interface BrowserEvents {
  /**
   * window.open or target=_blank: the engine already created the view, hidden until it is
   * attached. Without any listener the popup never shows: its first address loads in the opener
   * instead and the popup closes (a popup that stays on about:blank closes after 10 s).
   */
  'new-view': { view: View; opener: View | null };
  /** A download started; without any listener the file is saved automatically when done. */
  download: { download: Download };
  /**
   * The engine's memory runs short: close or discard background views. Reported at every further
   * growth of malloc by 32 MB while less than a reserve is left below `limit`, or above the expert
   * switch `BL_MEMORY_PRESSURE_MB` (3 GB, on iPhone and iPad 512 MB, where iOS ends the whole page
   * before the memory stops growing).
   */
  'memory-pressure': MemoryPressureEvent;
  /** No answer from the engine for 10 s after input (the time of a page dialog does not count). */
  unresponsive: Record<string, never>;
  /** The engine answers again after `unresponsive`. */
  responsive: Record<string, never>;
  /**
   * The engine stopped; call `destroy()`, then `createBrowser()` for a new one. `reason` is the
   * error of the thread that crashed (a trap or `abort()`) with its stack, WebAssembly frames by
   * function name when the engine keeps its name section, else as `wasm-function[index]:offset`;
   * at most 4096 characters.
   */
  crash: { reason: string };
  /** Network of the pages changed (host online and transport connected), see {@link Browser.online}. */
  network: { connected: boolean };
  /** Something works in a reduced way; also logged to the console. */
  warning: { code: WarningCode; message: string };
  /** A console message of a service worker (it has no view): `source` is its script URL, `line` 0. */
  'service-worker-console': ConsoleMessage;
}

/** A console message of a page ({@link ViewEvents}) or a service worker ({@link BrowserEvents}). */
export interface ConsoleMessage {
  level: 'log' | 'warn' | 'error' | 'debug' | 'info';
  message: string;
  /** Address of the script or document. */
  source: string;
  line: number;
}

/** Payload of the `memory-pressure` event of {@link Browser.on}, in bytes. */
export interface MemoryPressureEvent {
  /** Memory malloc of the engine took from its WebAssembly memory. */
  footprint: number;
  /**
   * Size the WebAssembly memory cannot grow beyond: found at runtime (about 1 GB in a 32 bit
   * browser), else the maximum of the engine build (4 GB).
   */
  limit: number;
  /**
   * 'critical': memory is short, less than 128 MB are left below `limit`, or above the budget of
   * the engine (`BL_MEMORY_PRESSURE_MB`, 512 MB on iPhone and iPad) inside the malloc area after a
   * release; the engine already dropped the compiled JS and the back/forward cache. 'moderate':
   * the footprint is above the budget while memory is not short (the footprint never shrinks);
   * freeing memory (closing background views) keeps it from growing further.
   */
  level: 'moderate' | 'critical';
}

/**
 * Codes of the `warning` event: 'storage-locked' another tab uses the storage namespace (data
 * stays in memory), 'media-sw-missing' media files cannot play without the service worker.
 */
export type WarningCode = 'storage-locked' | 'media-sw-missing';

/** Options of {@link Browser.createView}. */
export interface ViewOptions {
  /** First address, like typed into an address bar (see {@link View.load}). */
  url?: string;
  /** First page as an HTML string under a base URL (instead of `url`). */
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
  /** Unique per browser; views the pages open get ids from 2^20. */
  readonly id: number;
  /** Address of the main frame ('' before the first navigation). */
  readonly url: string;
  /**
   * Address of a navigation the host started (`load`, `back`, `forward`, `restoreHistory`) until
   * its document commits or it ends without one ('' otherwise). An address bar shows it instead of
   * `url` meanwhile, like Chrome: a slow server or an authentication prompt keeps the typed address
   * in view. Navigations of the page itself never set it, so a page cannot make the bar show an
   * address it is not on.
   */
  readonly pendingURL: string;
  readonly title: string;
  /** True from the start of a navigation until `load` or `error`. */
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Back/forward list, null before the first navigation. */
  readonly history: SessionHistory | null;
  /** Page zoom factor, 1 = 100 %. */
  readonly zoom: number;
  readonly muted: boolean;
  /** The page plays sound right now (event `media-state`). */
  readonly audible: boolean;
  /** True after `close`; every method is a no-op then. */
  readonly closed: boolean;
  /** The canvas the page is painted into (inside the container while attached). */
  readonly canvas: HTMLCanvasElement;
  /**
   * The keyboard focus is in the page. Its keys go to the page first; a keydown it does not handle
   * comes back as `unhandled-key`, where browser shortcuts run like in Chrome.
   */
  readonly focused: boolean;
  on<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): Unsubscribe;
  /** Shows the view in `container` (moves it from an earlier one); it follows its size. */
  attach(container: HTMLElement): void;
  /** Removes the canvas from the page; the view keeps running hidden. */
  detach(): void;
  /**
   * Loads an address like typed into an address bar. Without a scheme it gets https:// and, when
   * that fails without an answer of the site (no connection, no valid TLS), http:// after the
   * error page, like Chrome; localhost, IP addresses, names without a dot and addresses with a
   * port other than 80 get http:// right away (`typedAddress`). Like Chrome, an invalid
   * address (for example a port above 65535) loads nothing.
   */
  load(url: string): void;
  /** Loads an HTML string under a base URL. */
  loadHTML(html: string, baseURL: string): void;
  /** Reloads; the page may ask beforeunload (dialog with `reload: true`). */
  reload(): void;
  /** Stops loading. */
  stop(): void;
  back(): void;
  forward(): void;
  /** Puts back a back/forward list (from {@link View.history}) and loads its current entry. */
  restoreHistory(history: SessionHistory): void;
  /** Hidden views paint nothing and throttle their timers. */
  setVisible(visible: boolean): void;
  /** Keyboard focus into the page. */
  focus(): void;
  /** Moves focus to the first (forward) or last element, like Tab from outside. */
  focusFirstElement(forward: boolean): void;
  /** Page zoom factor (> 0), emits `zoom` when it changes. */
  setZoom(zoom: number): void;
  setMuted(muted: boolean): void;
  /**
   * Find in page (case insensitive, wraps around); `again` goes to the next match. The result
   * comes with the event `find`; matches stay marked until {@link View.stopFind}.
   */
  find(text: string, options?: { backwards?: boolean; again?: boolean }): void;
  /** Ends find and removes the marks. */
  stopFind(): void;
  /** Builds a PDF; delivered with the event `print`. */
  print(): void;
  /**
   * Page source like Chrome's Ctrl+U: the event `open-tab` asks for `view-source:<url>` in front.
   * Only for http(s) pages. A `view-source:` address loads in any view (`load`) as a page of its
   * own with history: the source of the address after the scheme with numbered lines.
   */
  viewSource(): void;
  /** Editor command on the focused element or selection of the page. */
  command(name: EditCommand): void;
  /** Puts text on the engine clipboard and pastes it. */
  paste(text: string): void;
  /** Ends fullscreen of the page (also ends host fullscreen). */
  exitFullscreen(): void;
  /**
   * Runs beforeunload unless `force`; resolves true when the view closed. Like Chrome, a page
   * that does not answer within 500 ms (busy) closes without asking. A scroll position not
   * reported yet comes as `history` event before `close`, so {@link View.history} is current then
   * (waits up to 50 ms for a busy engine thread).
   */
  close(options?: { force?: boolean }): Promise<boolean>;
}

/** Commands of {@link View.command}. */
export type EditCommand = 'Copy' | 'Cut' | 'Paste' | 'SelectAll' | 'Undo' | 'Redo';

/** A file of an upload, drop or paste the page did not get. */
export interface SkippedFile {
  name: string;
  /** 'too-large': over 512 MB; 'unreadable': the host could not read it. */
  reason: 'too-large' | 'unreadable';
}

/** Events of {@link View.on}. */
export interface ViewEvents {
  /**
   * The main frame starts a navigation to another document (a link, a form, script, the host,
   * back/forward), also while the page still loads, before the `navigation` event with `loading`
   * true. It ends with `commit` of its document, or without one with `navigation` (`loading`
   * false: stopped, a download, failed). Same-document navigations do not start one. A browser
   * shows its toolbar with it, like Chrome's browser controls while a page loads.
   */
  'navigation-start': Record<string, never>;
  /**
   * The address or back/forward state changed: at the start of a navigation (`loading` true),
   * for the new document (also one from the back/forward cache, followed by its `title`),
   * same-document navigations, and when loading ends.
   */
  navigation: {
    url: string;
    /** {@link View.pendingURL}; also emitted when only it ends (stop, the page stays). */
    pendingURL: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
    history: SessionHistory | null;
  };
  /**
   * The back/forward list changed without a navigation: the scroll position of the current entry
   * (at most once a second while the page scrolls), so {@link View.history} restores it.
   */
  history: { history: SessionHistory };
  /**
   * The main frame scrolled to `x`, `y` (pixels, like `scrollX`/`scrollY` of
   * {@link SessionHistory}), at most once per engine task. `user` is true for a scroll by the
   * user (wheel, finger and its fling, keys, scrollbar), false for one by the page's script or a
   * restored position. A browser hides its toolbar with it, like Chrome's browser controls.
   */
  scroll: { x: number; y: number; user: boolean };
  /** The title of the page changed, '' for a document without one; `url` is the page it belongs to. */
  title: { title: string; url: string };
  /** Load progress of the page (its main frame) from 0 to 1, 1 when done; iframes that navigate later do not report. */
  progress: { value: number };
  /** The zoom changed (setZoom or Ctrl + mouse wheel over the page). */
  zoom: { zoom: number };
  /**
   * A new document; `errorPage` is the kind of error page ('network', 'certificate', or 'http' for
   * an HTTP error status without a body) or null.
   */
  commit: { errorPage: string | null };
  /** The main frame finished loading (window load event); `loading` is false from here on. */
  load: Record<string, never>;
  /**
   * The main frame navigation failed; `description` is the error of the network layer in
   * English for logs (for example "Could not resolve hostname"), not a text for users. A failure
   * before the new page committed usually gets the engine's error page next (`commit` with
   * `errorPage`), which tells the user like in Chrome.
   */
  error: { description: string };
  /** First layout of a new document. */
  'first-layout': Record<string, never>;
  /** First paint of a new document. */
  'first-paint': Record<string, never>;
  /** A console message of the page. */
  console: ConsoleMessage;
  /**
   * Favicon of the page, null when it has none. Reported for every http(s) page once it has
   * loaded, also when the page before had the same icon.
   */
  icon: { blob: Blob | null };
  /** The pointer is over a link (its address) or left it (null). */
  hover: { url: string | null };
  /**
   * Result of {@link View.find} for `text`: `matches` (at most 1000, `more` when the page has
   * more) and the position of the current one from 1, 0 when nothing was found or the current
   * one comes after the first 1000. Results arrive in the order of the calls; one whose `text`
   * is not the latest belongs to an earlier search.
   */
  find: { text: string; matches: number; index: number; more: boolean };
  /** The page entered or left fullscreen (its container is fullscreen in the host). */
  fullscreen: { active: boolean };
  /** The page started or stopped playing sound. */
  'media-state': { audible: boolean };
  /** The page started or stopped using the camera, microphone or screen capture. */
  'capture-state': { active: boolean };
  /** A video of this view went into the host's picture-in-picture window or left it. */
  'picture-in-picture': { active: boolean };
  /** The page added or removed its last beforeunload listener (close may ask). */
  'beforeunload-state': { hasListener: boolean };
  /** Click, key, text or paste into the page (until the next document). */
  'user-activation': Record<string, never>;
  /**
   * Ctrl/Cmd, middle or Shift click on a link, also one with target=_blank (no `new-view` then),
   * or {@link View.viewSource}: the page stays, the host opens `url` as `disposition` says.
   */
  'open-tab': { url: string; disposition: LinkDisposition };
  /**
   * A window.open, target=_blank link or form without a user gesture was not opened, like in
   * Chrome. `url` is its address ('' for window.open without one), `origin` the origin of the
   * page in the view: `setPermission(origin, 'popups', 'grant')` lets its pages open windows.
   */
  'popup-blocked': { url: string; origin: string };
  /** mailto:, tel: and app links. */
  'external-url': { url: string };
  /** window.focus() */
  'focus-request': Record<string, never>;
  /** Tab moved focus past the first or last element of the page (not for the iOS keyboard's field arrows). */
  'take-focus': { forward: boolean };
  /**
   * A keydown the page did not handle: no preventDefault, editing command or default action like
   * scrolling. Like Chrome, a browser runs its shortcuts here (Ctrl+F, Ctrl+P, F5), so a page
   * that uses the key itself (its own find, Ctrl+U in a rich text editor) keeps it.
   */
  'unhandled-key': UnhandledKey;
  /** Right click or long press the page did not handle itself: show a context menu. */
  'context-menu': ContextMenuInfo;
  /** A PDF of the page from {@link View.print} or window.print(). */
  print: { pdf: Blob; title: string };
  /** Files of an upload, drop or paste the page did not get. */
  'files-skipped': { files: SkippedFile[] };
  /** The view closed (close(), window.close() or the end of the browser). */
  close: Record<string, never>;
}

/**
 * Where a link clicked with modifiers should open, like Chrome: `background` a tab behind the
 * current one (Ctrl/Cmd or middle click), `foreground` a tab in front (with Shift as well),
 * `window` a new window (Shift alone; a host without windows opens a tab in front).
 */
export type LinkDisposition = 'background' | 'foreground' | 'window';

/** A key of the event `unhandled-key`, with the fields of a KeyboardEvent. */
export interface UnhandledKey {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Where the user right clicked or long pressed; empty strings when there is no link, image or
 * selection.
 */
export interface ContextMenuInfo {
  /** Position in CSS pixels relative to the view canvas. */
  x: number;
  y: number;
  /** Address of the link under the pointer. */
  link: string;
  /** Address of the image under the pointer. */
  image: string;
  /** Selected text. */
  selection: string;
  /** Over an editable element (text field, contenteditable). */
  editable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * A long press of a finger (also of an emulated touch device) opened the menu, not a right
   * click: phones show a shorter menu for what was pressed, without the page commands.
   */
  touch: boolean;
}

/**
 * Answer of a dialog handler: confirm boolean, prompt string or null, beforeunload true to leave,
 * resubmit true to send the form again.
 */
export type DialogAnswer = boolean | string | null | undefined;

/**
 * Requests the engine waits for. Each has one handler here; extensions may put handlers in
 * front of it ({@link ExtensionContext.handle}).
 */
export interface RequestHandlers {
  /**
   * alert, confirm, prompt, beforeunload and resubmit, answered directly or with a promise (an
   * in-page dialog). Answer: confirm true for OK, prompt the text or null, beforeunload false to
   * stay, resubmit true to send the form again. Like in Chrome only the asking page waits for the
   * answer (with the popups it shares script with): it gets no input and holds back the view's
   * calls, its last frame stays. All other views go on. resubmit comes before a reload or
   * back/forward would send a form (POST) again, only its navigation waits; when the page
   * navigates or stops meanwhile, the signal aborts. A navigation of the view (`load`,
   * `reload`, `back`, ...) answers its open dialogs with the default first. The signal aborts
   * then, when the view closes or the engine ends. A native dialog of the host page
   * (`window.alert`) still stops the host page and so all views. Default: alert ignored,
   * confirm false, prompt null, beforeunload true, resubmit false (the page stays).
   */
  dialog(request: DialogRequest): DialogAnswer | Promise<DialogAnswer>;
  /**
   * Default 'dismiss'. 'grant' and 'deny' are remembered in the {@link PermissionStore};
   * 'dismiss' (also a thrown error) answers no for now and the page may ask again. Pages only
   * see notifications the host browser shows: grant 'notifications' after the host allowed them
   * (Notification.requestPermission), as the ui permission prompt does. When the page that asked
   * is left, the question is dismissed and its signal aborts.
   */
  permission(request: PermissionRequest): Promise<PermissionAnswer>;
  /**
   * HTTP authentication (401 with Basic or Digest), like the sign-in dialog of Chrome. Asked for
   * the main frame and same origin loads without stored credentials; loads of the same realm wait
   * for one answer. The credentials are kept for the session of the engine, so further requests to
   * the realm do not ask; refused ones ask again (`retry`). Default null: the page shows the 401
   * response.
   */
  authenticate(request: AuthRequest): Promise<AuthCredentials | null>;
  /** Default: the native file dialog of the host browser. */
  fileChooser(request: FileChooserRequest): Promise<File[] | null>;
  /** `<select>` popup; resolves the chosen index or -1. Default -1. */
  selectPopup(request: SelectRequest): Promise<number>;
  /** `<input type=color>`; resolves a #rrggbb value or null. Default null. */
  colorPicker(request: ColorRequest): Promise<string | null>;
  /** Date and time inputs; resolves the value string or null. Default null. */
  dateTimePicker(request: DateTimeRequest): Promise<string | null>;
  /**
   * Suggestions of an `<input list>` (a datalist) below the field, like the dropdown of Chrome.
   * Shown while the user types: the field keeps the focus and the keys. Every change of the
   * suggestions or of the highlighted one (Up and Down in the field) is a new request, the
   * signal of the old one aborts; Enter in the field takes the highlighted one, Escape closes.
   * Resolves the chosen index, -1 closes the list. Default -1 (no list).
   */
  dataListPopup(request: DataListRequest): Promise<number>;
  /**
   * Copy and cut in a page and its `navigator.clipboard.writeText()` and `write()`: puts the
   * text (and HTML) on a clipboard. Default: the clipboard of the host (`navigator.clipboard`,
   * with HTML when ClipboardItem exists).
   */
  clipboardWrite(request: ClipboardWriteRequest): void | Promise<void>;
}

/** A page dialog (handler `dialog`). */
export interface DialogRequest {
  view: View;
  /** resubmit: a reload or back/forward would send a form (POST) again. */
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'resubmit';
  /** Origin of the asking frame (for "<host> says"). */
  origin: string;
  /** Text of the page; empty for beforeunload (like Chrome, never shown) and resubmit. */
  message: string;
  /** Default text of a prompt. */
  defaultValue: string;
  /** beforeunload of a reload. */
  reload: boolean;
  /** Aborted when the view closes or the engine ends; the answer is ignored then. */
  signal: AbortSignal;
}

/**
 * Permissions of a site. 'camera-microphone' is one question for both. 'popups' is never asked:
 * granted, the pages of the origin open windows without a user gesture (`popup-blocked`).
 */
export type PermissionKind =
  | 'geolocation'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | 'camera-microphone'
  | 'popups';

/** A decision remembered in the {@link PermissionStore}. */
export type PermissionDecision = 'grant' | 'deny';

/** Answer of the permission handler; 'dismiss' is not remembered. */
export type PermissionAnswer = PermissionDecision | 'dismiss';

/** A permission question of a page (handler `permission`). */
export interface PermissionRequest {
  view: View;
  kind: PermissionKind;
  origin: string;
  /**
   * Aborted when the view's page is left (its main frame commits a new document, like Chrome),
   * the view closes or the engine ends; the question counts as dismissed then.
   */
  signal: AbortSignal;
}

/** A server asks for a user name and password (handler `authenticate`). */
export interface AuthRequest {
  view: View;
  /** Address that answered 401: the page or a same origin resource of it. */
  url: string;
  /** Origin of the server, what to show the user (like Chrome). */
  origin: string;
  /** Realm the server named, '' without one. Text of the server, not of the browser. */
  realm: string;
  scheme: 'basic' | 'digest';
  /** The credentials sent last were refused. */
  retry: boolean;
  /**
   * Aborted when no load waits for the answer any more (stopped, navigated away), the view closes
   * or the engine ends; the answer is ignored then.
   */
  signal: AbortSignal;
}

/** Answer of the `authenticate` handler. */
export interface AuthCredentials {
  username: string;
  password: string;
}

/** Text a page copied, cut or wrote with `navigator.clipboard` (handler `clipboardWrite`). */
export interface ClipboardWriteRequest {
  text: string;
  /** HTML of the selection, '' for plain text. */
  html: string;
}

/** A file input of a page (handler `fileChooser`). */
export interface FileChooserRequest {
  view: View;
  multiple: boolean;
  /** Value of the accept attribute. */
  accept: string;
  signal: AbortSignal;
}

/** An entry of a `<select>` popup. */
export interface SelectItem {
  text: string;
  tooltip: string;
  enabled: boolean;
  /** Group label (optgroup). */
  label: boolean;
  selected: boolean;
  separator: boolean;
}

/** A `<select>` popup of a page (handler `selectPopup`). */
export interface SelectRequest {
  view: View;
  rect: Rect;
  items: SelectItem[];
  selectedIndex: number;
  /** Aborted when the page hides the popup, the view closes or the engine stops. */
  signal: AbortSignal;
}

/** A suggestion of a datalist. */
export interface DataListSuggestion {
  value: string;
  /** Label of the option, '' when it has none or the same text as the value. */
  label: string;
}

/** Suggestions for the text in an `<input list>` of a page (handler `dataListPopup`). */
export interface DataListRequest {
  view: View;
  /** The field. */
  rect: Rect;
  /** Options starting with the typed text first, then those containing it. */
  suggestions: DataListSuggestion[];
  /** Entry highlighted with the keys in the field, -1 for none. */
  highlightedIndex: number;
  /** Aborted by the next request of the field, when the list closes, the view closes or the engine stops. */
  signal: AbortSignal;
}

/** An `<input type=color>` of a page (handler `colorPicker`). */
export interface ColorRequest {
  view: View;
  rect: Rect;
  value: string;
  signal: AbortSignal;
  /** Shows a value in the page while the picker is open (live preview). */
  preview(value: string): void;
}

/** A date or time input of a page (handler `dateTimePicker`). */
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

/**
 * Remembered permission decisions per origin, for example kept in the profile of the user.
 * Read once at the start (`entries`); written for every remembered answer and by
 * {@link Browser.setPermission}.
 */
export interface PermissionStore {
  /** Remembers a decision; null forgets it. */
  set(origin: string, kind: PermissionKind, value: PermissionDecision | null): void;
  /** Entries of unknown kinds are ignored. */
  entries(): Iterable<[origin: string, kind: string, value: PermissionDecision]>;
}

/** A download of the pages. The file is collected in memory and becomes a Blob when done. */
export interface Download {
  readonly id: number;
  /** View that started it, null when it is gone or unknown. */
  readonly view: View | null;
  readonly filename: string;
  readonly mime: string;
  /** Address the file came from ('data:' for data URLs). */
  readonly url: string;
  /** Expected size in bytes, 0 when unknown; the real size once done. */
  readonly size: number;
  /** Bytes received so far. */
  readonly received: number;
  readonly state: 'progress' | 'done' | 'error';
  /** Why it failed: the network error, 'HTTP <status>', 'Cancelled' or 'Aborted' (browser ended). */
  readonly error?: string;
  /** The file once done. */
  readonly blob: Blob | null;
  /** `progress` for every chunk, then exactly one `done` or `error`. */
  on(
    type: 'progress' | 'done' | 'error',
    listener: (event: { download: Download }) => void,
  ): Unsubscribe;
  /** Stops a running download; it ends with `error` 'Cancelled'. */
  cancel(): void;
  /** Saves the file with the download of the host browser. */
  save(): void;
}

/** Debug and test access, only with `debug: true`. */
export interface DebugApi {
  /** The raw Emscripten module (for DevTools only, not stable). */
  readonly module: unknown;
  /** Runs JavaScript in the page; the result goes to the console as [eval]. */
  eval(view: View, source: string): void;
  /**
   * Size of the engine memory; a report level writes a report to the console: 1 after a GC, 2
   * with the documents, 3 after releasing what memory pressure releases, 4 also with what in the
   * JS heap keeps documents without a frame alive (slow).
   */
  memory(report?: 0 | 1 | 2 | 3 | 4): number;
  /** Bytes allocated with malloc in the engine memory (walks the heap, slow). */
  memoryUsed(): number;
  /** Color at a CSS pixel of the visible page. */
  pagePixel(view: View, x: number, y: number): [number, number, number];
  pageRow(view: View, y: number): [number, number, number][];
  audioState(): unknown;
  mediaState(): unknown;
  rtcState(): unknown;
  /** Crashes the engine thread for real: abort() or a WebAssembly trap. */
  crash(kind: 'abort' | 'trap'): void;
  /**
   * Simulates a lost GPU: 'lose' and 'restore' the WebGL context the engine paints with,
   * 'lose-webgl' loses the host contexts of the WebGL canvases of the pages.
   */
  gpu(action: 'lose' | 'restore' | 'lose-webgl'): void;
  /**
   * Behaves like a memory-pressure message of the engine at its limit (level 'critical', footprint
   * and limit are the current size of the engine memory).
   */
  memoryPressure(): void;
  /**
   * The engine memory cannot grow beyond megabytes, malloc fails there (0: the real limit), so
   * memory-pressure comes as on a 32 bit browser. The engine looks for a limit only once malloc
   * uses 384 MB, so limits below about 600 MB come too late. Takes effect at the next task of
   * the engine.
   */
  memoryLimit(megabytes: number): void;
  /**
   * Frames the engine put on screen so far, all views together; null before the engine is ready.
   * A frame without a visible change is not shown.
   */
  framesShown(): number | null;
}
