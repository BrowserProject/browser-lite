import type { EngineModule } from './engine.js';
import { BrowserLiteError } from './errors.js';

interface Pending {
  viewId: number;
  resolve(png: Blob): void;
  reject(error: Error): void;
}

/**
 * Copy image ({@link View.copyImage}): the engine hit tests the point and answers with the image
 * there as PNG (bl_copy_image, onEngineCopyImage).
 */
export class ImageCopies {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly module: EngineModule) {}

  /** The image at the point of the view as PNG; rejects when there is none. */
  request(viewId: number, x: number, y: number): Promise<Blob> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { viewId, resolve, reject });
      this.module._bl_copy_image(viewId, id, x, y);
    });
  }

  /** The engine's answer; empty bytes when there was no image. */
  answer(id: number, png: Uint8Array<ArrayBuffer>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (png.length) entry.resolve(new Blob([png], { type: 'image/png' }));
    else entry.reject(new Error('No image at this point'));
  }

  /** The view closed (its held commands are dropped) or, without a view, the browser ended. */
  abort(viewId?: number): void {
    for (const [id, entry] of this.pending) {
      if (viewId !== undefined && entry.viewId !== viewId) continue;
      this.pending.delete(id);
      entry.reject(new BrowserLiteError('destroyed', 'Closed before the image was copied'));
    }
  }
}
