import type { Config } from '../config.js';
import type { EngineModule } from '../engine.js';
import type { HostService, WarningCode } from '../types.js';
import type { ViewImpl } from '../view.js';

/** Answers a host call of a page polyfill (engine WebPlatformExtras.cpp). */
export type HostCall<P> = (
  payload: P,
  origin: string,
  view: ViewImpl | undefined,
) => Promise<unknown>;

/** What a service gets from the browser it runs in. Lives as long as that browser. */
export interface ServiceContext {
  /** The engine module; exports are callable from start() on. */
  readonly module: EngineModule;
  readonly config: Config;
  /** Aborted when the browser is destroyed or crashed. */
  readonly signal: AbortSignal;
  /** UTF-8 copy for an export (the engine frees it). */
  text(value: string | null | undefined): number;
  /** Worker of the engine thread (capture streams, sinks). */
  engineWorker(): Worker | null;
  /** Handles an engine event (notifyHost type). */
  on<T>(type: string, handler: (data: T, view: ViewImpl | undefined) => void): void;
  hostCall<P>(name: string, handler: HostCall<P>): void;
  /** Runs for every view; the signal aborts when the view closes. */
  onView(setup: (view: ViewImpl, signal: AbortSignal) => void): void;
  /**
   * Click, key or touch into a view or anywhere in the host page, called inside the event
   * (the user activation of the host).
   */
  onUserGesture(listener: () => void): void;
  provide(key: string, value: unknown): void;
  use<T>(key: string): T | undefined;
  /** State for browser.debug (audioState, mediaState, rtcState). */
  debugState(name: 'audio' | 'media' | 'rtc', state: () => unknown): void;
  warn(code: WarningCode, message: string): void;
}

/** A host service. Instances only hold options; all state lives in setup() per browser. */
export abstract class Service implements HostService {
  /** Engine features (BL_FEATURES) the service serves. */
  abstract readonly features: readonly string[];

  constructor(readonly name: string) {}

  /**
   * Before the engine loads: module hooks and event handlers synchronously. A returned promise
   * (async preparation) runs while the engine loads; the browser is ready once it settles.
   */
  abstract setup(context: ServiceContext): void | Promise<void>;

  /** After the engine is ready. */
  start(_context: ServiceContext): void {}
}
