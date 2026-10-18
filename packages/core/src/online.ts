import type { EngineModule } from './engine.js';
import type { Transport } from './types.js';

/** navigator.onLine of the pages: network of the host and connection of the transport. */
export class Online {
  private online = true;

  constructor(
    private readonly module: EngineModule,
    private readonly transport: Transport,
    private readonly onChange: (online: boolean) => void,
  ) {}

  get value(): boolean {
    return this.online;
  }

  /** Follows the host and the transport until the signal aborts. */
  start(signal: AbortSignal): void {
    const update = () => {
      if (!signal.aborted) this.update();
    };
    this.transport.addEventListener('connectedchange', update, { signal });
    addEventListener('online', update, { signal });
    addEventListener('offline', update, { signal });
    this.update();
  }

  private update(): void {
    const now = navigator.onLine && this.transport.connected;
    if (now === this.online) return;
    this.online = now;
    this.module._bl_set_online(now ? 1 : 0);
    this.onChange(now);
  }
}
