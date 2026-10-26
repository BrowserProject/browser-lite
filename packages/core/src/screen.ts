import type { Config } from './config.js';
import type { EngineModule } from './engine.js';
import type { ColorScheme } from './types.js';

/**
 * Screen, color scheme (prefers-color-scheme), touch screen and pixel ratio for the pages:
 * like the host, or like the emulated device (size, pixel ratio, touch, coarse pointer).
 */
export class Screen {
  colorScheme: ColorScheme;
  private readonly dark = matchMedia('(prefers-color-scheme: dark)');

  constructor(
    private readonly module: EngineModule,
    private readonly config: Config,
    private readonly onPixelRatio: () => void,
  ) {
    this.colorScheme = config.colorScheme;
  }

  /** The emulated device's pixel ratio, else the host's up to maxPixelRatio. */
  pixelRatio(): number {
    return (
      this.config.device?.pixelRatio || Math.min(devicePixelRatio || 1, this.config.maxPixelRatio)
    );
  }

  /** A new limit of the pixel ratio: the views measure again. */
  setMaxPixelRatio(limit: number): void {
    this.config.maxPixelRatio = limit;
    this.onPixelRatio();
  }

  start(signal: AbortSignal): void {
    this.dark.addEventListener('change', () => this.send(), { signal });
    this.watchPixelRatio(signal);
    this.send();
  }

  // A monitor with another pixel ratio keeps the CSS size: ResizeObserver does not notice
  private watchPixelRatio(signal: AbortSignal): void {
    if (signal.aborted) return;
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        if (signal.aborted) return;
        this.onPixelRatio();
        this.send();
        this.watchPixelRatio(signal);
      },
      { once: true, signal },
    );
  }

  send(): void {
    const device = this.config.device;
    const dark = this.colorScheme === 'system' ? this.dark.matches : this.colorScheme === 'dark';
    const touch = device ? device.touch : navigator.maxTouchPoints > 0;
    const flags = (dark ? 1 : 0) | (touch ? 2 : 0) | (device?.mobile ? 4 : 0);
    if (device)
      this.module._bl_set_screen(device.width, device.height, device.width, device.height, flags);
    else
      this.module._bl_set_screen(
        screen.width,
        screen.height,
        screen.availWidth,
        screen.availHeight,
        flags,
      );
  }
}
