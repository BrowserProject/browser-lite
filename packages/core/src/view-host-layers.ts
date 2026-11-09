// Host layers of a view (engine/src/HostLayers.h): a layer of the page that only animates its
// opacity (a pulsing placeholder) gets a canvas of its own over the view canvas, which the engine's
// worker paints like the view canvas. Its opacity runs here as a Web Animation, sampled from the
// engine's animation and started at the same time, so the host browser animates it on its own
// compositor and the engine sends no frame for it.

/** A layer the engine asks for (event `layers`): its place in frame pixels and its opacity. */
export interface HostLayerRequest {
  key: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Duration of the samples in ms. */
  period: number;
  /** Repetitions of the samples, null for infinitely. */
  iterations: number | null;
  /** Start in ms since 1970 (`performance.timeOrigin + performance.now()`). */
  start: number;
  /** Times of the samples in ms, from 0 to `period`. */
  times: number[];
  /** Opacity at those times, linear between them. */
  opacity: number[];
}

/** Reads the requests of a `layers` event, null for a malformed one. */
export function hostLayerRequests(value: unknown): HostLayerRequest[] | null {
  if (!Array.isArray(value)) return null;
  const requests: HostLayerRequest[] = [];
  for (const item of value as Partial<HostLayerRequest>[]) {
    const numbers = [item.key, item.x, item.y, item.width, item.height, item.period, item.start];
    if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number)))
      return null;
    if (
      !Array.isArray(item.opacity) ||
      !Array.isArray(item.times) ||
      item.opacity.length < 2 ||
      item.times.length !== item.opacity.length
    )
      return null;
    requests.push(item as HostLayerRequest);
  }
  return requests;
}

/** The canvases of the host layers of one view, in the layer of its damage tiles. */
export class HostLayers {
  private readonly canvases = new Map<number, HTMLCanvasElement>();

  constructor(
    private readonly parent: HTMLElement,
    private readonly worker: Worker,
    private readonly viewId: number,
  ) {}

  /** Number of canvases. */
  get size(): number {
    return this.canvases.size;
  }

  /** Keeps the canvases of `keep`, makes those of `add` and removes all others. */
  update(keep: readonly number[], add: readonly HostLayerRequest[]): void {
    const wanted = new Set(keep);
    for (const layer of add) wanted.add(layer.key);
    for (const [key, canvas] of this.canvases) {
      if (wanted.has(key)) continue;
      canvas.remove();
      this.canvases.delete(key);
    }
    for (const layer of add) {
      this.canvases.get(layer.key)?.remove();
      const canvas = document.createElement('canvas');
      canvas.width = layer.width;
      canvas.height = layer.height;
      canvas.setAttribute('data-bl-layer', String(layer.key));
      // Above the damage tiles, which show the view without these layers
      canvas.style.cssText =
        `position:absolute;z-index:1;left:${layer.x}px;top:${layer.y}px;` +
        `width:${layer.width}px;height:${layer.height}px;object-fit:none;object-position:0 0;`;
      this.parent.append(canvas);
      this.canvases.set(layer.key, canvas);
      // Empty until the engine draws the layer into it, so the animation may run before
      const animation = canvas.animate(
        layer.opacity.map((opacity, index) => ({
          opacity,
          offset: Math.min(1, (layer.times[index] ?? 0) / layer.period),
        })),
        {
          duration: layer.period,
          iterations: layer.iterations ?? Number.POSITIVE_INFINITY,
          fill: 'forwards',
        },
      );
      animation.startTime = layer.start - performance.timeOrigin;
      const offscreen = canvas.transferControlToOffscreen();
      this.worker.postMessage({ blLayer: offscreen, viewId: this.viewId, key: layer.key }, [
        offscreen,
      ]);
    }
  }

  /** Draws the layers at their current opacity over a copy of the view drawn at `1 / ratio`. */
  drawOver(context: CanvasRenderingContext2D, ratio: number): void {
    for (const canvas of this.canvases.values()) {
      context.globalAlpha = Number(getComputedStyle(canvas).opacity);
      context.drawImage(
        canvas,
        Number.parseFloat(canvas.style.left) / ratio,
        Number.parseFloat(canvas.style.top) / ratio,
        canvas.width / ratio,
        canvas.height / ratio,
      );
    }
    context.globalAlpha = 1;
  }

  /** The view is closed. */
  remove(): void {
    for (const canvas of this.canvases.values()) canvas.remove();
    this.canvases.clear();
  }
}
