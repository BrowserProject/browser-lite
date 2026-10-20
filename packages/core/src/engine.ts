import { BrowserLiteError } from './errors.js';
import type { Transport } from './types.js';

type Export = (...args: number[]) => number;

/** abiVersion of engine/abi.json this core is written for (checked by tests/contract/abi-test.mjs). */
export const ENGINE_ABI_VERSION = 4;

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
  '_bl_measurements',
  '_bl_gpu_lose_context_for_testing',
  '_bl_gpu_restore_context_for_testing',
  '_bl_webgl_lose_context_for_testing',
  '_bl_host_call_result',
  '_bl_media_event',
  '_bl_media_frame',
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
  onAbort?: (what: unknown) => void;
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
  onRuntimeInitialized?: () => void;
  blTransport?: Transport;
  blEngineWorker?: () => Worker | null;
  blPresenterWorker?: () => Worker | null;
  blWriteFiles?: (files: { file: Blob; path: string }[]) => Promise<boolean[]>;
  blClearHttpCache?: () => Promise<void>;
  blClearBytecodeCache?: () => Promise<void>;
  blShutdown?: () => void;
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
