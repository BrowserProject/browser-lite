import type { EngineModule } from './engine.js';
import type { DebugApi, View } from './types.js';

interface DebugHost {
  readonly module: EngineModule;
  readonly ready: boolean;
  text(value: string): number;
  debugState(name: 'audio' | 'media' | 'rtc'): unknown;
  memoryPressure(): void;
}

// The canvas usually belongs to the engine worker: read it through drawImage
function snapshot(view: View, rows?: { y: number }): ImageData | null {
  const rect = view.canvas.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (!width || !height) return null;
  const probe = document.createElement('canvas');
  probe.width = width;
  probe.height = height;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  context.drawImage(view.canvas, 0, 0, width, height);
  return rows
    ? context.getImageData(0, Math.round(rows.y), width, 1)
    : context.getImageData(0, 0, width, height);
}

/** Debug and test access (only with `debug: true`). */
export class Debug implements DebugApi {
  constructor(private readonly host: DebugHost) {}

  get module(): unknown {
    return this.host.module;
  }

  eval(view: View, source: string): void {
    if (this.host.ready && !view.closed)
      this.host.module._bl_eval_script(view.id, this.host.text(source));
  }

  memory(report?: 0 | 1 | 2 | 3): number {
    const { module } = this.host;
    if (report !== undefined && this.host.ready) module._bl_memory_report(report);
    return module.HEAPU8?.length ?? 0;
  }

  memoryUsed(): number {
    return this.host.ready ? this.host.module._bl_memory_used() : 0;
  }

  pagePixel(view: View, x: number, y: number): [number, number, number] {
    const image = snapshot(view);
    if (!image) return [0, 0, 0];
    const px = Math.min(Math.max(Math.round(x), 0), image.width - 1);
    const py = Math.min(Math.max(Math.round(y), 0), image.height - 1);
    const at = (py * image.width + px) * 4;
    const d = image.data;
    return [d[at] ?? 0, d[at + 1] ?? 0, d[at + 2] ?? 0];
  }

  pageRow(view: View, y: number): [number, number, number][] {
    const image = snapshot(view, { y });
    const row: [number, number, number][] = [];
    if (!image) return row;
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) row.push([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0]);
    return row;
  }

  audioState(): unknown {
    return this.host.debugState('audio');
  }

  mediaState(): unknown {
    return this.host.debugState('media');
  }

  rtcState(): unknown {
    return this.host.debugState('rtc');
  }

  crash(kind: 'abort' | 'trap'): void {
    if (this.host.ready) this.host.module._bl_crash_for_testing(kind === 'trap' ? 1 : 0);
  }

  gpu(action: 'lose' | 'restore' | 'lose-webgl'): void {
    const { module, ready } = this.host;
    if (!ready) return;
    if (action === 'lose') module._bl_gpu_lose_context_for_testing();
    else if (action === 'restore') module._bl_gpu_restore_context_for_testing();
    else module._bl_webgl_lose_context_for_testing();
  }

  memoryPressure(): void {
    this.host.memoryPressure();
  }

  memoryLimit(megabytes: number): void {
    if (this.host.ready)
      this.host.module._bl_memory_limit_for_testing(Math.max(0, Math.round(megabytes)));
  }

  framesShown(): number | null {
    const count = this.host.ready ? this.host.module._bl_frames_shown_for_testing() : -1;
    return count < 0 ? null : count;
  }
}
