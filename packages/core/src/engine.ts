import { BrowserLiteError } from './errors.js';
import type { Transport } from './types.js';

type Export = (...args: number[]) => number;

/** Public exports of the engine (engine/abi.json). Strings are UTF-8 pointers the engine frees. */
export interface EngineExports {
  _bl_create_view: Export;
  _bl_destroy_view: Export;
  _bl_load_url: Export;
  _bl_load_html: Export;
  _bl_restore_history: Export;
  _bl_go_back: Export;
  _bl_go_forward: Export;
  _bl_reload: Export;
  _bl_stop: Export;
  _bl_try_close: Export;
  _bl_resize: Export;
  _bl_set_visible: Export;
  _bl_focus: Export;
  _bl_focus_initial: Export;
  _bl_set_zoom: Export;
  _bl_set_muted: Export;
  _bl_frame: Export;
  _bl_frame_presented: Export;
  _bl_mouse: Export;
  _bl_mouse_move: Export;
  _bl_wheel: Export;
  _bl_zoom_wheel: Export;
  _bl_pinch: Export;
  _bl_touch: Export;
  _bl_context_menu: Export;
  _bl_key: Export;
  _bl_insert_text: Export;
  _bl_set_composition: Export;
  _bl_confirm_composition: Export;
  _bl_set_clipboard: Export;
  _bl_set_clipboard_text: Export;
  _bl_command: Export;
  _bl_drag: Export;
  _bl_pointer_lock: Export;
  _bl_exit_fullscreen: Export;
  _bl_find: Export;
  _bl_find_done: Export;
  _bl_print: Export;
  _bl_view_source: Export;
  _bl_choose_files: Export;
  _bl_remove_path: Export;
  _bl_popup_choose: Export;
  _bl_color_chosen: Export;
  _bl_datetime_chosen: Export;
  _bl_permission_answer: Export;
  _bl_set_permission: Export;
  _bl_set_user_agent: Export;
  _bl_set_languages: Export;
  _bl_set_preferences: Export;
  _bl_set_screen: Export;
  _bl_set_online: Export;
  _bl_storage_flush: Export;
  _bl_input_mark: Export;
  _bl_input_mark_address: Export;
  _bl_eval_script: Export;
  _bl_memory_report: Export;
  _bl_memory_used: Export;
  _bl_crash_for_testing: Export;
  _bl_gpu_lose_context_for_testing: Export;
  _bl_gpu_restore_context_for_testing: Export;
  _bl_webgl_lose_context_for_testing: Export;
  _bl_host_call_result: Export;
  _bl_media_event: Export;
  _bl_media_frame: Export;
  _bl_media_fetch: Export;
  _bl_media_fetch_cancel: Export;
  _bl_capture_ended: Export;
  _bl_capture_failed: Export;
  _bl_remote_muted: Export;
  _bl_geolocation_position: Export;
  _bl_geolocation_error: Export;
  _bl_device_orientation: Export;
  _bl_device_motion: Export;
  _bl_gamepad: Export;
  _bl_speech_voices: Export;
  _bl_speech_event: Export;
  _bl_speech_recognition_event: Export;
  _bl_notification_event: Export;
}

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
    view: number,
    type: number,
    origin: string,
    message: string,
    defaultValue: string,
  ) => number;
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
  blTransport?: Transport;
  blEngineWorker?: () => Worker | null;
  blPresenterWorker?: () => Worker | null;
  blWriteFiles?: (files: { file: Blob; path: string }[]) => Promise<boolean[]>;
  blClearHttpCache?: () => Promise<void>;
  blClearBytecodeCache?: () => Promise<void>;
  blShutdown?: () => void;
}

type Factory = (module: Partial<EngineModule>) => Promise<EngineModule>;

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
