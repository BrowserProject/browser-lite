import type { FrameAnswer, FrameRequest } from './frame-reader-worker.js';

interface PendingRead {
  player: number;
  video: HTMLVideoElement;
  width: number;
  height: number;
  resolve(pixels: Uint8Array | null): void;
}

/**
 * Reads the pixels of host `<video>` frames for the engine: RGBA, not premultiplied, scaled to the
 * requested size. drawImage of a video plus getImageData is a synchronous GPU readback (30 to 160
 * ms for a 1080p frame in Chromium); on the main thread it kept the host UI from input for as long
 * as a page read video frames. So where the host has `VideoFrame`, the main thread only takes the
 * frame (well under 1 ms) and a module worker (frame-reader-worker.ts) draws and reads it. Without
 * `VideoFrame` or the worker, and from the first failure of the worker on, it reads on the main
 * thread.
 */
export class FrameReader {
  /** undefined: not started yet, null: reads on the main thread. */
  private worker: Worker | null | undefined;
  private readonly pending = new Map<number, PendingRead>();
  private nextId = 1;
  private readonly contexts = new Map<number, OffscreenCanvasRenderingContext2D>();

  /** The current frame of `video` at `width` x `height`; null if it cannot be read. */
  read(
    player: number,
    video: HTMLVideoElement,
    width: number,
    height: number,
  ): Promise<Uint8Array | null> {
    const worker = this.start();
    let frame: VideoFrame | null = null;
    if (worker) {
      try {
        frame = new VideoFrame(video);
      } catch {
        // No frame to take right now (Safari between sources): this one on the main thread
      }
    }
    if (!worker || !frame) return Promise.resolve(this.readHere(player, video, width, height));
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, { player, video, width, height, resolve });
      const request: FrameRequest = { type: 'read', id, player, frame, width, height };
      worker.postMessage(request, [frame]);
    });
  }

  /** The player is gone: its canvas can go. */
  release(player: number): void {
    this.contexts.delete(player);
    const request: FrameRequest = { type: 'release', player };
    this.worker?.postMessage(request);
  }

  /** Ends the worker; reads still on the way resolve with null. */
  close(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const read of this.pending.values()) read.resolve(null);
    this.pending.clear();
    this.contexts.clear();
  }

  private start(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    this.worker = null;
    if (typeof VideoFrame !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./frame-reader-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
    worker.onmessage = ({ data }: MessageEvent<FrameAnswer>) => {
      const read = this.pending.get(data.id);
      if (!read) return;
      if (!data.pixels) {
        console.warn('[browser-lite] Video frames on the main thread:', data.error);
        this.fail();
        return;
      }
      this.pending.delete(data.id);
      read.resolve(new Uint8Array(data.pixels));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      console.warn('[browser-lite] Video frames on the main thread:', event.message);
      this.fail();
    };
    worker.onmessageerror = () => this.fail();
    this.worker = worker;
    return worker;
  }

  // The worker cannot read frames (not served, CSP, a host without VideoFrame in drawImage): the
  // reads on the way and all later ones run on the main thread
  private fail(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const read of this.pending.values())
      read.resolve(this.readHere(read.player, read.video, read.width, read.height));
    this.pending.clear();
  }

  private readHere(
    player: number,
    video: HTMLVideoElement,
    width: number,
    height: number,
  ): Uint8Array | null {
    let context = this.contexts.get(player);
    if (!context || context.canvas.width !== width || context.canvas.height !== height) {
      // With alpha: VP9 and HEVC videos can be transparent. Each frame replaces the last one.
      const created = new OffscreenCanvas(width, height).getContext('2d', {
        willReadFrequently: true,
      });
      if (!created) return null;
      created.globalCompositeOperation = 'copy';
      this.contexts.set(player, created);
      context = created;
    }
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
  }
}
