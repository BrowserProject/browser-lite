import type { Config } from './config.js';
import type { EngineModule } from './engine.js';
import type { ColorScheme } from './types.js';

/** A pointer event of the host with its place in the window and on the screen. */
export interface ScreenPoint {
  clientX: number;
  clientY: number;
  screenX?: number;
  screenY?: number;
}

/**
 * Screen, color scheme (prefers-color-scheme), touch screen and pixel ratio for the pages:
 * like the host, or like the emulated device (size, pixel ratio, touch, coarse pointer).
 * prefers-reduced-motion and prefers-contrast always follow the host.
 *
 * Also where the pages lie on the screen: the host window is the window of every page
 * (window.screenX/Y, outerWidth/Height), so the browser UI around a view counts as its window's
 * chrome like in a browser; a view's screen position (screenX/Y of its input events) is the
 * host's viewport on the screen plus the view's place in the host page. An emulated device is
 * a phone whose browser window fills its screen, with the browser's bar above the view.
 */
export class Screen {
  colorScheme: ColorScheme;
  private readonly dark = matchMedia('(prefers-color-scheme: dark)');
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly moreContrast = matchMedia('(prefers-contrast: more)');
  private readonly lessContrast = matchMedia('(prefers-contrast: less)');
  private window = '';
  // The host's viewport on the screen as its last pointer event showed it (null: none yet)
  private viewport: { x: number; y: number } | null = null;

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
    for (const query of [this.dark, this.reducedMotion, this.moreContrast, this.lessContrast])
      query.addEventListener('change', () => this.send(), { signal });
    // A moved window fires nothing: it is checked again with every pointer event (viewOrigin)
    for (const type of ['resize', 'focus', 'pageshow'])
      addEventListener(type, () => this.sendWindow(), { signal });
    this.watchPixelRatio(signal);
    this.send();
  }

  /**
   * Where the top left corner of a view at rect (in the host's viewport, `height` the view's
   * height for the engine) lies on the screen, taken from the host event that comes with it.
   * Sends the window first when it moved.
   */
  viewOrigin(
    rect: { left: number; top: number },
    height: number,
    e?: ScreenPoint,
  ): [number, number] {
    this.sendWindow();
    const device = this.config.device;
    if (device) return [0, Math.max(0, device.height - height)];
    if (e?.screenX !== undefined && e.screenY !== undefined)
      this.viewport = { x: e.screenX - e.clientX, y: e.screenY - e.clientY };
    const viewport = this.viewport ?? estimatedViewport();
    return [viewport.x + rect.left, viewport.y + rect.top];
  }

  // The host window: its place and outer size, an emulated device's screen
  private sendWindow(): void {
    const device = this.config.device;
    const rect = device
      ? [0, 0, device.width, device.height]
      : [screenX, screenY, outerWidth || innerWidth, outerHeight || innerHeight];
    const key = rect.join();
    if (key === this.window) return;
    this.window = key;
    this.module._bl_set_window(...(rect as [number, number, number, number]));
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
    const flags =
      (dark ? 1 : 0) |
      (touch ? 2 : 0) |
      (device?.mobile ? 4 : 0) |
      (this.reducedMotion.matches ? 8 : 0) |
      (this.moreContrast.matches ? 16 : 0) |
      (this.lessContrast.matches ? 32 : 0);
    this.window = '';
    this.sendWindow();
    if (device) {
      this.module._bl_set_screen(
        0,
        0,
        device.width,
        device.height,
        0,
        0,
        device.width,
        device.height,
        flags,
      );
      return;
    }
    // left, top (Chromium, Firefox) and availLeft, availTop (also Safari) place the screen among
    // the host's screens, like the window's screenX and screenY
    const host: typeof screen & {
      left?: number;
      top?: number;
      availLeft?: number;
      availTop?: number;
    } = screen;
    this.module._bl_set_screen(
      host.left ?? 0,
      host.top ?? 0,
      host.width,
      host.height,
      host.availLeft ?? 0,
      host.availTop ?? 0,
      host.availWidth,
      host.availHeight,
      flags,
    );
  }
}

// Before the first pointer event: Firefox knows its viewport on the screen, other browsers have
// their frame around it, as wide on the left as on the right and below
function estimatedViewport(): { x: number; y: number } {
  const firefox = globalThis as { mozInnerScreenX?: number; mozInnerScreenY?: number };
  if (firefox.mozInnerScreenX !== undefined && firefox.mozInnerScreenY !== undefined)
    return { x: firefox.mozInnerScreenX, y: firefox.mozInnerScreenY };
  const frame = Math.max(0, (outerWidth - innerWidth) / 2);
  return { x: screenX + frame, y: screenY + Math.max(0, outerHeight - innerHeight - frame) };
}
