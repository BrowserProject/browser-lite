import { BrowserLiteError } from './errors.js';
import type { StartProgress, Transport } from './types.js';

type Export = (...args: number[]) => number;

/** abiVersion of engine/abi.json this core is written for (checked by tests/contract/abi-test.mjs). */
export const ENGINE_ABI_VERSION = 10;

/** Public exports of the engine the core calls (engine/abi.json). */
const ENGINE_EXPORTS = [
  '_bl_create_view',
  '_bl_destroy_view',
  '_bl_load_url',
  '_bl_load_html',
  '_bl_restore_history',
  '_bl_go_back',
  '_bl_go_forward',
  '_bl_reload',
  '_bl_stop',
  '_bl_try_close',
  '_bl_resize',
  '_bl_set_visible',
  '_bl_focus',
  '_bl_focus_initial',
  '_bl_set_zoom',
  '_bl_set_muted',
  '_bl_frame',
  '_bl_frame_presented',
  '_bl_mouse',
  '_bl_mouse_move',
  '_bl_wheel',
  '_bl_zoom_wheel',
  '_bl_pinch',
  '_bl_touch',
  '_bl_context_menu',
  '_bl_key',
  '_bl_insert_text',
  '_bl_set_composition',
  '_bl_confirm_composition',
  '_bl_set_clipboard',
  '_bl_set_clipboard_text',
  '_bl_command',
  '_bl_drag',
  '_bl_pointer_lock',
  '_bl_exit_fullscreen',
  '_bl_find',
  '_bl_find_done',
  '_bl_print',
  '_bl_view_source',
  '_bl_choose_files',
  '_bl_remove_path',
  '_bl_popup_choose',
  '_bl_color_chosen',
  '_bl_datetime_chosen',
  '_bl_permission_answer',
  '_bl_set_permission',
  '_bl_set_user_agent',
  '_bl_set_languages',
  '_bl_set_preferences',
  '_bl_set_screen',
  '_bl_set_online',
  '_bl_storage_flush',
  '_bl_input_mark',
  '_bl_input_mark_address',
  '_bl_eval_script',
  '_bl_memory_report',
  '_bl_memory_used',
  '_bl_crash_for_testing',
  '_bl_memory_limit_for_testing',
  '_bl_frames_shown_for_testing',
  '_bl_gpu_lose_context_for_testing',
  '_bl_gpu_restore_context_for_testing',
  '_bl_webgl_lose_context_for_testing',
  '_bl_host_call_result',
  '_bl_media_event',
  '_bl_media_frame',
  '_bl_media_presented',
  '_bl_media_fetch',
  '_bl_media_fetch_cancel',
  '_bl_capture_ended',
  '_bl_capture_failed',
  '_bl_remote_muted',
  '_bl_geolocation_position',
  '_bl_geolocation_error',
  '_bl_device_orientation',
  '_bl_device_motion',
  '_bl_gamepad',
  '_bl_speech_voices',
  '_bl_speech_event',
  '_bl_speech_recognition_event',
  '_bl_notification_event',
  '_bl_dialog_answer',
  '_bl_download_cancel',
] as const;

/** Public exports of the engine. Strings are UTF-8 pointers the engine frees. */
export type EngineExports = Record<(typeof ENGINE_EXPORTS)[number], Export>;

/** Callbacks the engine calls on the main thread (Module hooks). */
export interface EngineHooks {
  onEngineReady?: () => void;
  onEngineEvent?: (view: number, type: string, payload: string, fromEngineThread: boolean) => void;
  onEngineFrame?: (
    view: number,
    ptr: number,
    width: number,
    height: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ) => void;
  onEngineNeedsFrame?: (view: number) => void;
  onEngineDownloadData?: (id: number, bytes: Uint8Array<ArrayBuffer>) => void;
  onEnginePrint?: (view: number, bytes: Uint8Array<ArrayBuffer>, title: string) => void;
  onEngineIcon?: (view: number, url: string, mime: string, bytes: Uint8Array<ArrayBuffer>) => void;
  onEngineAudio?: (
    type: string,
    id: number,
    ptr: number,
    capacity: number,
    channels: number,
    sampleRate: number,
  ) => void;
  onEngineMedia?: (
    player: number,
    type: string,
    data: Record<string, unknown>,
    bytes: Uint8Array<ArrayBuffer> | null,
  ) => void;
  onEngineMediaFetch?: (
    fetchId: number,
    type: string,
    data: Record<string, unknown> | null,
    bytes: Uint8Array<ArrayBuffer> | null,
  ) => void;
  engineDialog?: (
    dialog: number,
    view: number,
    type: number,
    origin: string,
    message: string,
    defaultValue: string,
  ) => void;
}

/** The Emscripten module of engine.js as far as the core uses it. */
export interface EngineModule extends EngineExports, EngineHooks {
  HEAPU8: Uint8Array;
  ENV: Record<string, string>;
  stringToNewUTF8(text: string): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  locateFile?: (path: string) => string;
  mainScriptUrlOrBlob?: string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  preRun?: ((module: EngineModule) => void)[];
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object;
  getPreloadedPackage?: (url: string, size: number) => ArrayBuffer | null;
  blCrashReason?: () => string;
  blTransport?: Transport;
  blEngineWorker?: () => Worker | null;
  blPresenterWorker?: () => Worker | null;
  blWriteFiles?: (files: { file: Blob; path: string }[]) => Promise<boolean[]>;
  blClearHttpCache?: () => Promise<void>;
  blShutdown?: () => void;
  blSetDeferred?: (module: WebAssembly.Module) => Promise<void>;
  blAbiVersion?: number;
}

type Factory = (module: Partial<EngineModule>) => Promise<EngineModule>;

/**
 * Refuses an engine of another contract (an engine release of another version) before the
 * first call into it.
 * @throws BrowserLiteError with code `engine-load-failed`
 */
export function checkEngine(module: EngineModule): void {
  const version = module.blAbiVersion;
  if (version !== ENGINE_ABI_VERSION)
    throw new BrowserLiteError(
      'engine-load-failed',
      `The engine has ABI version ${version ?? 'unknown'}, this core needs ${ENGINE_ABI_VERSION}: use the engine release of the same version as @browser-lite/core`,
    );
  const missing = ENGINE_EXPORTS.filter((name) => typeof module[name] !== 'function');
  if (missing.length)
    throw new BrowserLiteError('engine-load-failed', `The engine lacks ${missing.join(', ')}`);
}

const factories = new Map<string, Promise<Factory>>();

/** Requests of the engine files, started before anything else of the start. */
export interface EngineFiles {
  /** engine.js loaded (createBrowserLiteEngine). */
  readonly factory: Promise<Factory>;
  /** engine.wasm, compiled while it downloads. */
  readonly wasm: Promise<WebAssembly.Module>;
  /** engine.data (fonts, certificates, fontconfig). */
  readonly data: Promise<ArrayBuffer>;
}

async function fetchEngineFile(url: string): Promise<Response> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok)
    throw new BrowserLiteError(
      'engine-load-failed',
      `Could not load ${url}: HTTP ${response.status}`,
    );
  return response;
}

const PROGRESS_INTERVAL_MS = 100;

/**
 * Counts the bytes of engine.wasm and engine.data for {@link StartProgress}. Only for a download:
 * reading a copy of the body costs about 0.1 to 0.2 s even when the files come from the cache, so
 * the files count as cached when engine.js came from the cache (same release, same folder).
 */
class DownloadProgress {
  private loaded = 0;
  /** Size from manifest.json, else the sum of unencoded Content-Lengths once both are known. */
  private manifestTotal = 0;
  private lengths: number[] = [];
  private last = 0;
  private finished = false;
  /** Resolves to true when the files are downloaded, so their bytes are counted. */
  readonly counting: Promise<boolean>;

  constructor(
    private readonly report: (progress: StartProgress) => void,
    base: string,
    factory: Promise<unknown>,
    loadedBefore: boolean,
  ) {
    const scriptUrl = `${base}engine.js`;
    this.counting = loadedBefore
      ? Promise.resolve(false)
      : factory.then(
          () => {
            const entry = performance.getEntriesByName(scriptUrl, 'resource').at(-1) as
              | PerformanceResourceTiming
              | undefined;
            return !entry || entry.transferSize > 0;
          },
          () => false,
        );
    this.counting.then((counting) => {
      if (counting) this.readTotal(`${base}manifest.json`);
    });
  }

  /** Counts the body of `response` (a copy of it, the caller consumes the original). */
  count(response: Response): void {
    // Without the manifest only an unencoded length tells the size of the body
    const length = Number(response.headers.get('Content-Length'));
    this.lengths.push(response.headers.get('Content-Encoding') ? 0 : length || 0);
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const read = (): Promise<void> =>
      reader.read().then(({ done, value }) => {
        if (done) return;
        this.add(value.byteLength);
        return read();
      });
    read().catch(() => {});
  }

  /** The files are there, the engine starts. */
  done(): void {
    if (this.finished) return;
    this.finished = true;
    this.emit({ phase: 'start', loaded: this.loaded, total: this.size() });
  }

  private size(): number {
    if (this.manifestTotal) return this.manifestTotal;
    return this.lengths.length === 2 && this.lengths.every(Boolean)
      ? this.lengths.reduce((sum, length) => sum + length, 0)
      : 0;
  }

  private readTotal(url: string): void {
    fetch(url, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest: { files?: Record<string, { size?: number }> } | null) => {
        const files = manifest?.files;
        const size = (name: string) => Number(files?.[name]?.size) || 0;
        const wasm = size('engine.wasm');
        const data = size('engine.data');
        if (wasm && data) this.manifestTotal = wasm + data;
      })
      .catch(() => {});
  }

  private add(bytes: number): void {
    this.loaded += bytes;
    const now = performance.now();
    if (this.finished || now - this.last < PROGRESS_INTERVAL_MS) return;
    this.last = now;
    this.emit({ phase: 'download', loaded: this.loaded, total: this.size() });
  }

  private emit(progress: StartProgress): void {
    try {
      this.report(progress);
    } catch (error) {
      console.warn('[browser-lite] onProgress failed:', error);
    }
  }
}

/**
 * Requests engine.js, engine.wasm and engine.data at once, one request each: the start then runs
 * the storage lock and beforeStart while they load. engine.wasm compiles while it streams (the
 * host's code cache applies); without the type application/wasm it compiles after the download.
 * With `onProgress` a download is counted ({@link DownloadProgress}).
 */
export function loadEngineFiles(
  base: string,
  onProgress?: (progress: StartProgress) => void,
): EngineFiles {
  const scriptUrl = `${base}engine.js`;
  const loadedBefore = factories.has(scriptUrl);
  const factory = loadEngineFactory(scriptUrl);
  const progress = onProgress && new DownloadProgress(onProgress, base, factory, loadedBefore);
  const counted = async (response: Response) => {
    if (progress && (await progress.counting)) progress.count(response);
    return response;
  };
  const files: EngineFiles = {
    factory,
    wasm: fetchEngineFile(`${base}engine.wasm`)
      .then(counted)
      .then(async (response) =>
        response.headers.get('Content-Type')?.startsWith('application/wasm')
          ? WebAssembly.compileStreaming(response)
          : WebAssembly.compile(await response.arrayBuffer()),
      ),
    data: fetchEngineFile(`${base}engine.data`)
      .then(counted)
      .then((response) => response.arrayBuffer()),
  };
  // A failure counts where the start waits for the file
  for (const file of Object.values(files)) file.catch(() => {});
  if (progress)
    Promise.all([files.wasm, files.data]).then(
      () => progress.done(),
      () => {},
    );
  return files;
}

/**
 * Hands the files to Emscripten so it requests none of them again: engine.data through
 * getPreloadedPackage (needed when the module starts), engine.wasm through instantiateWasm (it
 * waits for the compilation). Errors of the instantiation go to fail.
 */
export function provideEngineFiles(
  module: EngineModule,
  wasm: Promise<WebAssembly.Module>,
  data: ArrayBuffer,
  fail: (error: unknown) => void,
): void {
  let pending: ArrayBuffer | null = data;
  module.getPreloadedPackage = () => {
    const result = pending;
    pending = null;
    return result;
  };
  module.instantiateWasm = (imports, receive) => {
    wasm
      .then(async (compiled) => receive(await WebAssembly.instantiate(compiled, imports), compiled))
      .catch(fail);
    return {};
  };
}

/**
 * Fetches and compiles engine.deferred.wasm of a split engine (#238) once engine.wasm is there:
 * its engine.wasm (custom section "bl.deferred") holds what the start and common pages run.
 * Compiled while it streams, so Chrome's code cache applies like for engine.wasm. Resolves null
 * for an unsplit engine. Threads that need deferred code before it reached them read it
 * themselves, so a failure here only leaves that to them.
 */
export async function loadDeferredCode(
  base: string,
  wasm: Promise<WebAssembly.Module>,
): Promise<WebAssembly.Module | null> {
  if (!WebAssembly.Module.customSections(await wasm, 'bl.deferred').length) return null;
  const response = await fetchEngineFile(`${base}engine.deferred.wasm`);
  return response.headers.get('Content-Type')?.startsWith('application/wasm')
    ? WebAssembly.compileStreaming(response)
    : WebAssembly.compile(await response.arrayBuffer());
}

/** Loads engine.js once per URL (a classic script, it defines createBrowserLiteEngine). */
export function loadEngineFactory(scriptUrl: string): Promise<Factory> {
  let factory = factories.get(scriptUrl);
  if (!factory) {
    factory = new Promise<Factory>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onload = () => {
        const create = (globalThis as { createBrowserLiteEngine?: Factory })
          .createBrowserLiteEngine;
        if (typeof create === 'function') resolve(create);
        else reject(new BrowserLiteError('engine-load-failed', `${scriptUrl} is no engine`));
      };
      script.onerror = () =>
        reject(new BrowserLiteError('engine-load-failed', `Could not load ${scriptUrl}`));
      document.head.append(script);
    });
    factory.catch(() => factories.delete(scriptUrl));
    factories.set(scriptUrl, factory);
  }
  return factory;
}
