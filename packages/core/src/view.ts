import { HttpFallback, httpFallback, typedAddress } from './address.js';
import type { Config } from './config.js';
import { Emitter } from './emitter.js';
import type { EngineModule } from './engine.js';
import type { Fullscreen } from './fullscreen.js';
import { attachPointerInput } from './input.js';
import {
  attachFieldArrows,
  createImeField,
  enterKeyHintSetter,
  focusOpensKeyboard,
} from './keyboard.js';
import { PendingNavigation } from './pending.js';
import type { Requests } from './requests.js';
import type {
  ContextMenuInfo,
  EditCommand,
  SessionHistory,
  Unsubscribe,
  View,
  ViewEvents,
  ViewOptions,
} from './types.js';
import { type Uploads, uploadDirectory } from './uploads.js';
import type { Watchdog } from './watchdog.js';

// Like Chrome: a page that does not answer beforeunload in time (its engine thread is busy)
// closes without asking, so that closing a tab never waits on a busy page
const BEFOREUNLOAD_TIMEOUT_MS = 500;

/** What a view needs from its browser. */
export interface ViewHost {
  readonly module: EngineModule;
  readonly config: Config;
  /** True while the engine runs (not crashed, not destroyed). */
  readonly ready: boolean;
  readonly watchdog: Watchdog;
  readonly requests: Requests;
  text(value: string | null | undefined): number;
  pixelRatio(): number;
  presenter(): Worker | null;
  pageHidden(): boolean;
  defaultSize(): { width: number; height: number };
  readonly uploads: Uploads;
  readonly fullscreen: Fullscreen;
  gesture(): void;
  focusView(view: ViewImpl): void;
  removeView(view: ViewImpl): void;
}

interface Caret {
  x: number;
  y: number;
  height: number;
}

/** One page (tab or popup) of the engine with its canvas, keyboard field and input. */
export class ViewImpl implements View {
  url = '';
  title = '';
  loading = false;
  canGoBack = false;
  canGoForward = false;
  history: SessionHistory | null = null;
  zoom = 1;
  muted = false;
  audible = false;
  closed = false;
  readonly canvas: HTMLCanvasElement;
  /** @internal */ onWheelResult: ((consumed: boolean) => void) | null = null;
  /** @internal */ hasBeforeUnload = false;
  /** @internal */ userActivated = false;
  /** @internal The last key sent was the Tab of a field arrow (attachFieldArrows). */
  tabFromFieldArrow = false;
  // The last context menu request came from a finger (long press), not a right click: the
  // engine answers the latest request, a long press only once the finger lifts
  private menuByTouch = false;
  private readonly ime: HTMLTextAreaElement;
  private readonly forgetImeText: () => void;
  private readonly setEnterKeyHint: (hint: string) => void;
  private readonly fieldArrows: { place: () => void; remove: () => void };
  private imeModeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly events = new Emitter<ViewEvents>();
  private readonly pending = new PendingNavigation();
  private readonly fallback = new HttpFallback();
  private readonly lifetime = new AbortController();
  private readonly resizeObserver: ResizeObserver;
  private readonly context2d: CanvasRenderingContext2D | null = null;
  private container: HTMLElement | null = null;
  private visible: boolean;
  private engineVisible: boolean;
  private size = { width: 0, height: 0 };
  private device: { width: number; height: number } | null = null;
  private canvasRatio = 0;
  private frameRequested = false;
  private caret: Caret | null = null;
  private closing: Promise<boolean> | null = null;
  private resolveClosing: ((closed: boolean) => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** @internal */ readonly host: ViewHost,
    readonly id: number,
    options: ViewOptions,
    fromEngine: boolean,
  ) {
    const device = host.config.device;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-bl-view', String(id));
    // position:relative: video overlays (#232) lie before the canvas, underneath it
    this.canvas.style.cssText =
      'display:block;position:relative;outline:none;touch-action:none;' +
      'object-fit:none;object-position:0 0;transform-origin:0 0;';
    this.limitToDevice(device);
    // The canvas goes to the worker that paints (compositor or engine thread); only where
    // that is impossible the pixels are copied here (presentFrame)
    const worker =
      typeof this.canvas.transferControlToOffscreen === 'function' ? host.presenter() : null;
    if (worker) {
      const offscreen = this.canvas.transferControlToOffscreen();
      worker.postMessage({ blCanvas: offscreen, viewId: id }, [offscreen]);
    } else {
      this.context2d = this.canvas.getContext('2d', { alpha: false });
    }
    const ime = createImeField(this, this.lifetime.signal);
    this.ime = ime.field;
    this.forgetImeText = ime.forget;
    this.setEnterKeyHint = enterKeyHintSetter(this.ime, this.lifetime.signal);
    this.fieldArrows = attachFieldArrows(this, this.ime, this.lifetime.signal);
    attachPointerInput(this, this.lifetime.signal);
    this.resizeObserver = new ResizeObserver(() => this.measure());

    this.visible = options.visible !== false;
    if (options.container) this.place(options.container);
    const { width, height } = this.measureNow() ?? host.defaultSize();
    this.size = { width, height };
    const { module } = host;
    if (fromEngine) {
      this.engineVisible = true;
      module._bl_resize(id, width, height, host.pixelRatio());
    } else {
      this.engineVisible = true;
      // The first request waits for the new view (seconds on a slow phone): its connection opens
      // meanwhile
      const history = options.history;
      const first = history?.entries?.length ? history.entries[history.index]?.url : options.url;
      if (first) module._bl_preconnect(host.text(first));
      module._bl_create_view(id, width, height, host.pixelRatio());
    }
    this.updateVisibility();
    const zoom = options.zoom ?? 1;
    if (zoom !== 1 || !fromEngine) this.setZoom(zoom);
    if (options.history?.entries?.length) this.restoreHistory(options.history);
    else if (options.html) this.loadHTML(options.html.html, options.html.baseURL);
    else if (options.url) this.load(options.url);
  }

  /** @internal True while calls into the engine are allowed. */
  get alive(): boolean {
    return !this.closed && this.host.ready;
  }

  /** @internal Visible for the page right now. */
  get visibleNow(): boolean {
    return this.engineVisible;
  }

  /** @internal Position of a pointer event in CSS pixels of the view. */
  position(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  /** @internal A right click (touch false) or long press (touch true) asks for the context menu. */
  requestContextMenu(x: number, y: number, touch: boolean): void {
    this.menuByTouch = touch;
    this.host.module._bl_context_menu(this.id, x, y);
  }

  /** @internal Click, key or text into the page. */
  userInput(focus = true): void {
    if (focus) {
      // A click or tap can move the caret
      this.forgetImeText();
      this.focus();
    }
    this.host.gesture();
    if (!this.userActivated) {
      this.userActivated = true;
      this.emit('user-activation', {});
    }
  }

  /** @internal */
  emit<K extends keyof ViewEvents>(type: K, event: ViewEvents[K]): void {
    this.events.emit(type, event);
  }

  on<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): Unsubscribe {
    return this.events.on(type, listener);
  }

  attach(container: HTMLElement): void {
    if (this.closed || container === this.container) return;
    this.place(container);
    this.measure();
    this.updateVisibility();
  }

  detach(): void {
    if (!this.container) return;
    this.resizeObserver.disconnect();
    this.canvas.remove();
    this.ime.remove();
    this.fieldArrows.remove();
    this.container = null;
    this.updateVisibility();
  }

  private place(container: HTMLElement): void {
    this.resizeObserver.disconnect();
    container.append(this.canvas, this.ime);
    this.container = container;
    this.resizeObserver.observe(this.canvas);
    this.canvas.style.display = this.visible ? 'block' : 'none';
  }

  /** @internal Container while attached (fullscreen). */
  get element(): HTMLElement | null {
    return this.container;
  }

  private measureNow(): { width: number; height: number } | null {
    let rect = this.container ? this.canvas.getBoundingClientRect() : null;
    if (rect && (!rect.width || !rect.height) && this.container)
      rect = this.container.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    const device = this.host.config.device;
    const width = Math.max(1, Math.round(Math.min(rect.width, device?.width ?? Infinity)));
    const height = Math.max(1, Math.round(Math.min(rect.height, device?.height ?? Infinity)));
    return { width, height };
  }

  /** @internal The canvas keeps at most the emulated device's screen size, centered. */
  limitToDevice(device: { width: number; height: number } | null): void {
    this.device = device;
    this.canvasRatio = 0;
    this.fitCanvas();
  }

  /**
   * The canvas shows its frame pixel for pixel at the view's pixel ratio, anchored at the top
   * left: its box is `ratio` times the view, shrunk back with a transform, and the frame keeps
   * its natural size in it (`object-fit: none`). A frame of another size (after a rotation or
   * an on-screen keyboard, until the engine painted the new size) is cut off or leaves the rest
   * empty instead of being stretched, like Chrome.
   */
  private fitCanvas(): void {
    const ratio = this.host.pixelRatio();
    if (ratio === this.canvasRatio) return;
    this.canvasRatio = ratio;
    const device = this.device;
    const style = this.canvas.style;
    style.width = `${ratio * 100}%`;
    style.height = `${ratio * 100}%`;
    style.transform = `scale(${1 / ratio})`;
    style.maxWidth = device ? `${device.width * ratio}px` : '';
    style.maxHeight = device ? `${device.height * ratio}px` : '';
    style.marginLeft = device ? `max(0px, (100% - ${device.width}px) / 2)` : '';
  }

  /** @internal Sends the current size (resize, pixel ratio change). */
  measure(force = false): void {
    this.fitCanvas();
    const size = this.measureNow();
    if (!size || !this.alive) return;
    if (!force && size.width === this.size.width && size.height === this.size.height) return;
    this.size = size;
    this.host.module._bl_resize(this.id, size.width, size.height, this.host.pixelRatio());
  }

  /** @internal Last size sent to the engine. */
  get viewSize(): { width: number; height: number } {
    return this.size;
  }

  /** @internal */
  updateVisibility(): void {
    const visible = this.visible && !!this.container && !this.host.pageHidden();
    if (visible === this.engineVisible || !this.alive) return;
    this.engineVisible = visible;
    this.host.module._bl_set_visible(this.id, visible ? 1 : 0);
  }

  // A view with an open dialog answers only after it (the engine holds its calls back)
  private call(fn: (module: EngineModule) => void, expectAnswer = false): void {
    if (!this.alive) return;
    if (expectAnswer && !this.host.requests.hasDialog(this)) this.host.watchdog.expectAnswer();
    fn(this.host.module);
  }

  // Like Chrome, a navigation first ends the open dialogs of the view with their default answer
  private navigate(fn: (module: EngineModule) => void, expectAnswer = false): void {
    if (!this.alive) return;
    this.fallback.start('');
    this.host.requests.closeDialogs(this);
    this.call(fn, expectAnswer);
  }

  get pendingURL(): string {
    return this.pending.url;
  }

  load(url: string): void {
    const address = typedAddress(url);
    this.pending.start(address);
    // Without a document address (mailto:, an invalid one) the engine decides as for a link
    this.loadFromPage(address || url);
    this.fallback.start(httpFallback(url));
  }

  /** @internal An address a page asked for (a popup nobody shows): no pending address. */
  loadFromPage(url: string): void {
    this.navigate((m) => m._bl_load_url(this.id, this.host.text(url)), true);
  }

  loadHTML(html: string, baseURL: string): void {
    this.navigate(
      (m) => m._bl_load_html(this.id, this.host.text(html), this.host.text(baseURL)),
      true,
    );
  }

  reload(): void {
    this.navigate((m) => m._bl_reload(this.id), true);
  }

  stop(): void {
    this.fallback.start('');
    this.call((m) => m._bl_stop(this.id));
    this.endPending();
  }

  back(): void {
    this.pending.start(this.historyEntry(-1));
    this.navigate((m) => m._bl_go_back(this.id));
  }

  forward(): void {
    this.pending.start(this.historyEntry(1));
    this.navigate((m) => m._bl_go_forward(this.id));
  }

  // Address of the back/forward entry at offset from the current one, '' when unknown
  private historyEntry(offset: number): string {
    const history = this.history;
    return history ? typedAddress(history.entries[history.index + offset]?.url ?? '') : '';
  }

  /** @internal The pending navigation ended without an engine event (stop, beforeunload stays). */
  endPending(): void {
    if (this.pending.end()) this.emitNavigation();
  }

  private emitNavigation(): void {
    this.emit('navigation', {
      url: this.url,
      pendingURL: this.pending.url,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      loading: this.loading,
      history: this.history,
    });
  }

  restoreHistory(history: SessionHistory): void {
    const { entries, index } = history;
    this.pending.start(
      typedAddress(entries[Math.min(Math.max(index, 0), entries.length - 1)]?.url ?? ''),
    );
    this.navigate(
      (m) => m._bl_restore_history(this.id, this.host.text(JSON.stringify(history))),
      true,
    );
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.display = visible ? 'block' : 'none';
    this.updateVisibility();
    if (visible) this.measure();
  }

  /**
   * Opens the on-screen keyboard for the page's field that just got an input mode, only while the
   * user's tap still counts (transient activation), so a page cannot open it by itself. Chrome opens
   * it at a tap only when the focused element wants one at that moment, but the page's field comes
   * from the engine after the tap; a focus by script after a tap opens it too, and Chrome closes
   * such a keyboard for none. (One from VirtualKeyboard.show() stayed open after none and blur().)
   * A later tap while the mode is set opens it again without help.
   */
  private showKeyboard(): void {
    if (!focusOpensKeyboard() || document.activeElement !== this.ime) return;
    if (!navigator.userActivation?.isActive) return;
    this.ime.blur();
    this.ime.focus({ preventScroll: true });
  }

  focus(): void {
    if (!this.alive) return;
    this.host.focusView(this);
    this.ime.focus({ preventScroll: true });
  }

  /** @internal Engine focus flag of the page (one focused view at a time). */
  setEngineFocus(focused: boolean): void {
    this.call((m) => m._bl_focus(this.id, focused ? 1 : 0));
  }

  focusFirstElement(forward: boolean): void {
    this.focus();
    this.call((m) => m._bl_focus_initial(this.id, forward ? 1 : 0));
  }

  setZoom(zoom: number): void {
    if (!(zoom > 0) || !Number.isFinite(zoom)) return;
    const changed = zoom !== this.zoom;
    this.zoom = zoom;
    this.call((m) => m._bl_set_zoom(this.id, zoom));
    if (changed) this.emit('zoom', { zoom });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.call((m) => m._bl_set_muted(this.id, muted ? 1 : 0));
  }

  find(text: string, options?: { backwards?: boolean; again?: boolean }): void {
    this.call(
      (m) =>
        m._bl_find(
          this.id,
          this.host.text(text),
          options?.backwards ? 1 : 0,
          options?.again ? 1 : 0,
        ),
      true,
    );
  }

  stopFind(): void {
    this.call((m) => m._bl_find_done(this.id));
  }

  print(): void {
    this.call((m) => m._bl_print(this.id));
  }

  viewSource(): void {
    this.call((m) => m._bl_view_source(this.id));
  }

  command(name: EditCommand): void {
    this.call((m) => m._bl_command(this.id, this.host.text(name)));
  }

  paste(text: string): void {
    this.call((m) => {
      m._bl_set_clipboard_text(this.host.text(text));
      m._bl_command(this.id, this.host.text('Paste'));
    });
  }

  exitFullscreen(): void {
    this.host.fullscreen.setFullscreen(this, false);
    this.call((m) => m._bl_exit_fullscreen(this.id));
  }

  close(options?: { force?: boolean }): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    if (!this.alive || options?.force || !this.hasBeforeUnload) {
      this.dispose();
      return Promise.resolve(true);
    }
    if (!this.closing) {
      this.closing = new Promise((resolve) => {
        this.resolveClosing = resolve;
      });
      this.call((m) => m._bl_try_close(this.id), true);
      // An open beforeunload question waits for the user, the answer comes as 'try-close'
      this.closeTimer = setTimeout(() => {
        if (!this.host.requests.hasDialog(this, 'beforeunload')) this.dispose();
      }, BEFOREUNLOAD_TIMEOUT_MS);
    }
    return this.closing;
  }

  /** @internal Closes the view (also after window.close() or when the browser ends). */
  dispose(): void {
    if (this.closed) return;
    const alive = this.alive;
    this.closed = true;
    clearTimeout(this.imeModeTimer);
    clearTimeout(this.closeTimer);
    this.lifetime.abort();
    this.host.requests.closeView(this);
    this.host.fullscreen.setFullscreen(this, false);
    if (alive) {
      const { module } = this.host;
      module._bl_destroy_view(this.id);
      module._bl_remove_path(this.host.text(uploadDirectory(this.id)));
    }
    this.resizeObserver.disconnect();
    this.canvas.remove();
    this.ime.remove();
    this.container = null;
    this.resolveClosing?.(true);
    this.resolveClosing = null;
    this.host.removeView(this);
    this.emit('close', {});
    this.events.clear();
  }

  /** @internal Aborted when the view closes. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** @internal The engine needs a new frame: on the next display refresh. */
  needsFrame(): void {
    if (this.frameRequested || this.closed) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      if (this.alive) this.host.module._bl_frame(this.id);
    });
  }

  /** @internal A frame is ready in shared memory (only without OffscreenCanvas transfer). */
  presentFrame(
    ptr: number,
    width: number,
    height: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ): void {
    const context = this.context2d;
    if (!context) return;
    const canvas = this.canvas;
    let x = dirtyX;
    let y = dirtyY;
    let w = dirtyWidth;
    let h = dirtyHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      x = 0;
      y = 0;
      w = width;
      h = height;
    }
    if (w <= 0 || h <= 0) return;
    // ImageData must not point at a SharedArrayBuffer: copy the rows
    const pixels = new Uint8ClampedArray(w * h * 4);
    const heap = this.host.module.blHeap();
    for (let row = 0; row < h; row++) {
      const start = ptr + ((y + row) * width + x) * 4;
      pixels.set(heap.subarray(start, start + w * 4), row * w * 4);
    }
    context.putImageData(new ImageData(pixels, w, h), x, y);
  }

  // Input field at the caret: the input method shows its suggestions there
  private placeIme(): void {
    const caret = this.caret;
    if (!caret || !this.container) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ime.style.left = `${rect.left + caret.x}px`;
    this.ime.style.top = `${rect.top + caret.y}px`;
    this.ime.style.height = `${Math.max(caret.height, 10)}px`;
    this.fieldArrows.place();
  }

  /** @internal Engine event of this view (other types are ignored). */
  engineEvent(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'navigation': {
        const url = String(data.url ?? '');
        const history = (data.history as SessionHistory | undefined) ?? null;
        this.url = url;
        this.canGoBack = !!data.canGoBack;
        this.canGoForward = !!data.canGoForward;
        this.loading = !!data.loading;
        if (history) this.history = history;
        this.pending.update(url, this.loading);
        this.emitNavigation();
        return;
      }
      case 'title':
        this.title = String(data.title ?? '');
        this.emit('title', { title: this.title, url: String(data.url ?? this.url) });
        return;
      case 'progress':
        this.emit('progress', { value: Number(data.progress) || 0 });
        return;
      case 'commit': {
        // A new document (its navigation event follows): no user activation yet
        const errorPage = (data.errorPage as string | undefined) || null;
        this.pending.end();
        this.fallback.commit(errorPage);
        this.userActivated = false;
        this.emit('commit', { errorPage });
        return;
      }
      case 'first-layout':
      case 'first-paint':
        this.emit(type, {});
        return;
      case 'load': {
        this.loading = false;
        this.emit('load', {});
        const fallback = this.fallback.load();
        if (fallback) this.load(fallback);
        return;
      }
      case 'error':
        this.loading = false;
        this.fallback.error();
        this.pending.end();
        this.emit('error', { description: String(data.description ?? '') });
        return;
      case 'hover':
        this.canvas.title = String(data.tooltip ?? '');
        this.emit('hover', { url: (data.link as string) || null });
        return;
      case 'find':
        this.emit('find', { matches: Number(data.matches) || 0, index: Number(data.index) || 0 });
        return;
      case 'fullscreen':
        this.host.fullscreen.setFullscreen(this, !!data.on);
        this.emit('fullscreen', { active: !!data.on });
        return;
      case 'pointer-lock':
        this.host.fullscreen.setPointerLock(this, !!data.on);
        return;
      case 'media-state':
        this.audible = !!data.audio;
        this.emit('media-state', { audible: this.audible });
        return;
      case 'capture-state':
        this.emit('capture-state', { active: !!data.active });
        return;
      case 'beforeunload':
        this.hasBeforeUnload = !!data.listener;
        this.emit('beforeunload-state', { hasListener: this.hasBeforeUnload });
        return;
      case 'external-url':
        // A navigation went to another app (also after a redirect): the view stays where it is
        this.fallback.start('');
        this.endPending();
        this.emit(type, { url: String(data.url ?? '') });
        return;
      case 'open-tab':
        this.emit(type, { url: String(data.url ?? '') });
        return;
      case 'popup-blocked':
        this.emit(type, { url: String(data.url ?? ''), origin: String(data.origin ?? '') });
        return;
      case 'focus':
        this.emit('focus-request', {});
        return;
      case 'take-focus':
        if (this.tabFromFieldArrow) return;
        this.emit('take-focus', { forward: data.forward !== false });
        return;
      case 'context-menu':
        this.emit('context-menu', {
          x: Number(data.x) || 0,
          y: Number(data.y) || 0,
          link: String(data.link ?? ''),
          image: String(data.image ?? ''),
          selection: String(data.selection ?? ''),
          editable: !!data.editable,
          canGoBack: !!data.canGoBack,
          canGoForward: !!data.canGoForward,
          touch: this.menuByTouch,
        } satisfies ContextMenuInfo);
        return;
      case 'cursor':
        this.canvas.style.cursor = String(data.cursor ?? '');
        return;
      case 'caret':
        this.caret = data as unknown as Caret;
        this.placeIme();
        return;
      case 'text-input': {
        // The on-screen keyboard follows the focused field of the page, none without one. A page
        // that moves the focus from one field to another (Google's search box opens an overlay
        // with its own field) passes through none: Android would close the keyboard and not open
        // it again without a new tap, so none applies only when no field follows soon
        const mode = String(data.mode ?? '') || 'none';
        const enterKeyHint = String(data.enterKeyHint ?? '');
        this.forgetImeText();
        clearTimeout(this.imeModeTimer);
        const apply = () => {
          const opens = mode !== 'none' && this.ime.inputMode === 'none';
          this.ime.inputMode = mode;
          this.setEnterKeyHint(enterKeyHint);
          if (opens) this.showKeyboard();
        };
        if (mode === 'none' && this.ime.inputMode !== 'none')
          this.imeModeTimer = setTimeout(apply, 300);
        else apply();
        return;
      }
      case 'wheel-result':
        this.onWheelResult?.(!!data.consumed);
        return;
      case 'try-close': {
        clearTimeout(this.closeTimer);
        const resolve = this.resolveClosing;
        this.closing = null;
        this.resolveClosing = null;
        if (data.close) this.dispose();
        resolve?.(!!data.close);
        return;
      }
      case 'close':
        this.dispose();
        return;
    }
  }
}
