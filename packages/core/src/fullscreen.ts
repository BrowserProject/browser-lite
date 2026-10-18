import type { EngineModule } from './engine.js';
import type { ViewImpl } from './view.js';

/**
 * Fullscreen and pointer lock of the pages. Fullscreen puts the container of the view into
 * host fullscreen; pointer lock keeps the mouse in the canvas (games, 3D), Esc of the host ends
 * both.
 */
export class Fullscreen {
  private fullscreenView: ViewImpl | null = null;
  private pointerLockView: ViewImpl | null = null;

  constructor(
    private readonly module: EngineModule,
    private readonly views: () => Iterable<ViewImpl>,
  ) {}

  /** Follows the host fullscreen and pointer lock until the signal aborts. */
  start(signal: AbortSignal): void {
    document.addEventListener(
      'fullscreenchange',
      () => {
        const view = this.fullscreenView;
        if (document.fullscreenElement || !view) return;
        this.fullscreenView = null;
        if (view.alive) this.module._bl_exit_fullscreen(view.id);
      },
      { signal },
    );
    document.addEventListener(
      'pointerlockchange',
      () => {
        const view = [...this.views()].find((v) => v.canvas === document.pointerLockElement);
        const previous = this.pointerLockView;
        if (previous && previous !== view && previous.alive)
          this.module._bl_pointer_lock(previous.id, 0);
        this.pointerLockView = view ?? null;
      },
      { signal },
    );
  }

  /** The view closed. */
  forget(view: ViewImpl): void {
    if (this.pointerLockView === view) this.pointerLockView = null;
  }

  setFullscreen(view: ViewImpl, on: boolean): void {
    if (!on) {
      if (this.fullscreenView !== view) return;
      this.fullscreenView = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      return;
    }
    const element = view.element;
    const fail = () => {
      if (this.fullscreenView === view) this.fullscreenView = null;
      if (view.alive) this.module._bl_exit_fullscreen(view.id);
    };
    if (!element) {
      fail();
      return;
    }
    this.fullscreenView = view;
    // Without user activation the host refuses
    if (document.fullscreenElement !== element) element.requestFullscreen?.().catch(fail);
  }

  setPointerLock(view: ViewImpl, on: boolean): void {
    const canvas = view.canvas;
    if (!on) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      return;
    }
    const request = canvas.requestPointerLock as (options?: {
      unadjustedMovement?: boolean;
    }) => Promise<void> | undefined;
    Promise.resolve(request.call(canvas, { unadjustedMovement: true }))
      .catch(() => request.call(canvas))
      .then(
        () => {
          if (view.alive)
            this.module._bl_pointer_lock(view.id, document.pointerLockElement === canvas ? 1 : 0);
        },
        () => {
          if (view.alive) this.module._bl_pointer_lock(view.id, 0);
        },
      );
  }
}
