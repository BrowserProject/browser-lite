// Host layers of a view (engine/src/HostLayers.h): a layer of the page that only animates its
// opacity and transform (a pulsing placeholder or dot) gets a canvas of its own over the view canvas,
// which the engine's worker paints like the view canvas. Its opacity and transform run here as a Web
// Animation, sampled from the engine's animation and started at the same time, so the host browser
// animates it on its own compositor and the engine sends no frame for it. Layers of the page drawn
// after it over it (its covers) get a canvas without animation right above it.

/** The animation of a host layer, sampled. */
export interface HostLayerAnimation {
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
  /**
   * Transform at those times if it animates, linear between them: per sample `scaleX, scaleY, x, y`,
   * scaled from the canvas's top left corner, then moved by `x` and `y` frame pixels.
   */
  transform?: number[];
}

/**
 * A canvas the engine asks for (event `layers`): its place in frame pixels, above those asked for
 * before it, and the animation of a host layer (none for the covers of one).
 */
export interface HostLayerRequest extends Partial<HostLayerAnimation> {
  key: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Reads the requests of a `layers` event, null for a malformed one. */
export function hostLayerRequests(value: unknown): HostLayerRequest[] | null {
  if (!Array.isArray(value)) return null;
  const requests: HostLayerRequest[] = [];
  for (const item of value as Partial<HostLayerRequest>[]) {
    const numbers = [item.key, item.x, item.y, item.width, item.height];
    if (item.times !== undefined) numbers.push(item.period, item.start);
    if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number)))
      return null;
    if (item.times === undefined) {
      requests.push(item as HostLayerRequest);
      continue;
    }
    if (
      !Array.isArray(item.opacity) ||
      !Array.isArray(item.times) ||
      item.opacity.length < 2 ||
      item.times.length !== item.opacity.length
    )
      return null;
    if (
      item.transform !== undefined &&
      (!Array.isArray(item.transform) || item.transform.length !== 4 * item.opacity.length)
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
      canvas.setAttribute(isAnimated(layer) ? 'data-bl-layer' : 'data-bl-cover', String(layer.key));
      // Above the damage tiles, which show the view without these layers
      canvas.style.cssText =
        `position:absolute;z-index:1;left:${layer.x}px;top:${layer.y}px;` +
        `width:${layer.width}px;height:${layer.height}px;object-fit:none;object-position:0 0;` +
        'transform-origin:0 0;';
      this.parent.append(canvas);
      this.canvases.set(layer.key, canvas);
      if (isAnimated(layer)) animate(canvas, layer);
      const offscreen = canvas.transferControlToOffscreen();
      this.worker.postMessage({ blLayer: offscreen, viewId: this.viewId, key: layer.key }, [
        offscreen,
      ]);
    }
  }

  /** Draws the layers as they show now over a copy of the view drawn at `1 / ratio`. */
  drawOver(context: CanvasRenderingContext2D, ratio: number): void {
    for (const canvas of this.canvases.values()) {
      const style = getComputedStyle(canvas);
      context.save();
      context.globalAlpha = Number(style.opacity);
      context.scale(1 / ratio, 1 / ratio);
      context.translate(Number.parseFloat(canvas.style.left), Number.parseFloat(canvas.style.top));
      if (style.transform !== 'none') context.transform(...matrixOf(style.transform));
      context.drawImage(canvas, 0, 0);
      context.restore();
    }
  }

  /** The view is closed. */
  remove(): void {
    for (const canvas of this.canvases.values()) canvas.remove();
    this.canvases.clear();
  }
}

function isAnimated(layer: HostLayerRequest): layer is HostLayerRequest & HostLayerAnimation {
  return layer.times !== undefined;
}

/** Runs the layer's animation on its canvas (empty until the engine draws into it, so it may run before). */
function animate(canvas: HTMLCanvasElement, layer: HostLayerAnimation): void {
  const { transform } = layer;
  const animation = canvas.animate(
    layer.opacity.map((opacity, index) => ({
      opacity,
      offset: Math.min(1, (layer.times[index] ?? 0) / layer.period),
      ...(transform ? { transform: transformAt(transform, index) } : {}),
    })),
    {
      duration: layer.period,
      iterations: layer.iterations ?? Number.POSITIVE_INFINITY,
      fill: 'forwards',
    },
  );
  animation.startTime = layer.start - performance.timeOrigin;
}

/** CSS transform of sample `index` (four numbers per sample). */
function transformAt(transform: readonly number[], index: number): string {
  const [scaleX, scaleY, x, y] = transform.slice(4 * index, 4 * index + 4);
  return `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`;
}

/** The six numbers of a computed 2D transform (`matrix(a, b, c, d, e, f)`). */
function matrixOf(transform: string): [number, number, number, number, number, number] {
  const matrix = new DOMMatrix(transform);
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}
