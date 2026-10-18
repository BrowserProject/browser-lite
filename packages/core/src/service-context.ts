import type { Config } from './config.js';
import type { EngineModule } from './engine.js';
import type { HostCall, ServiceContext } from './services/service.js';
import type { WarningCode } from './types.js';
import type { ViewImpl } from './view.js';

type DebugState = 'audio' | 'media' | 'rtc';

interface RegistryHost {
  readonly module: EngineModule;
  readonly config: Config;
  readonly ready: boolean;
  text(value: string | null | undefined): number;
  handle<T>(type: string, handler: (data: T, view: ViewImpl | undefined) => void): void;
  warn(code: WarningCode, message: string): void;
}

/**
 * What the host services register with their browser: host calls of the page polyfills, view
 * setups, gesture listeners, shared values and debug state. Hands out the {@link ServiceContext}.
 */
export class ServiceRegistry {
  readonly context: ServiceContext;
  private readonly hostCalls = new Map<string, HostCall<unknown>>();
  private readonly viewSetups: ((view: ViewImpl, signal: AbortSignal) => void)[] = [];
  private readonly gestureListeners: (() => void)[] = [];
  private readonly provided = new Map<string, unknown>();
  private readonly debugStates = new Map<DebugState, () => unknown>();

  constructor(
    private readonly host: RegistryHost,
    signal: AbortSignal,
  ) {
    host.handle<Record<string, unknown>>('host-call', (data, view) => {
      void this.hostCall(data, view);
    });
    this.context = {
      module: host.module,
      config: host.config,
      signal,
      text: (value) => host.text(value),
      engineWorker: () => host.module.blEngineWorker?.() ?? null,
      on: (type, handler) => host.handle(type, handler),
      hostCall: <P>(name: string, handler: HostCall<P>) => {
        if (this.hostCalls.has(name)) throw new Error(`Host call ${name} is handled twice`);
        this.hostCalls.set(name, handler as HostCall<unknown>);
      },
      onView: (setup) => {
        this.viewSetups.push(setup);
      },
      onUserGesture: (listener) => {
        this.gestureListeners.push(listener);
      },
      provide: (key, value) => {
        this.provided.set(key, value);
      },
      use: <T>(key: string) => this.provided.get(key) as T | undefined,
      debugState: (name, state) => {
        this.debugStates.set(name, state);
      },
      warn: (code, message) => host.warn(code, message),
    };
  }

  /** Runs the view setups of the services for a new view. */
  setupView(view: ViewImpl): void {
    for (const setup of this.viewSetups) {
      try {
        setup(view, view.signal);
      } catch (error) {
        console.warn('[browser-lite] service view setup failed:', error);
      }
    }
  }

  /** Click, key or touch into a view. */
  gesture(): void {
    for (const listener of this.gestureListeners) listener();
  }

  debugState(name: DebugState): unknown {
    return this.debugStates.get(name)?.() ?? null;
  }

  private async hostCall(data: Record<string, unknown>, view: ViewImpl | undefined) {
    const { host } = this;
    const id = Number(data.id);
    const send = (ok: boolean, value: unknown) => {
      if (host.ready)
        host.module._bl_host_call_result(id, ok ? 1 : 0, host.text(JSON.stringify(value ?? null)));
    };
    const handler = this.hostCalls.get(String(data.name));
    if (!handler) {
      send(false, { name: 'NotSupportedError', message: 'Not supported' });
      return;
    }
    try {
      const payload = JSON.parse(String(data.payload || 'null'));
      send(true, await handler(payload, String(data.origin || ''), view));
    } catch (error) {
      const e = error as { name?: string; message?: string } | null;
      send(false, { name: e?.name || 'NotSupportedError', message: e?.message || String(error) });
    }
  }
}
