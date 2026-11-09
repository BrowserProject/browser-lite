// Damage tiles of a view (engine/src/DamageTiles.h): the host browser repaints a canvas whole for
// every new frame, so a frame that changes only a small part of the page (a spinner, a pulsing
// placeholder) goes into small canvases over the view canvas instead, and the host repaints only
// those. The engine asks for the tiles it needs (event 'tiles'); they cover the view canvas in a
// grid of `size` frame pixels and belong to the worker that paints, like the view canvas. The same
// layer holds the canvases of the host layers above them (view-host-layers.ts).

import { type HostLayerRequest, HostLayers } from './view-host-layers.js';

/** Tile key of the engine: `row << 16 | column`. */
function columnOf(key: number): number {
  return key & 0xffff;
}

function rowOf(key: number): number {
  return key >>> 16;
}

/** The tile canvases of one view, in a layer over the view canvas. */
export class ViewTiles {
  private readonly layer = document.createElement('div');
  private readonly tiles = new Map<number, HTMLCanvasElement>();
  private readonly hostLayers: HostLayers;
  private readonly observer = new ResizeObserver(() => this.place());
  private size = 0;
  private observed: HTMLElement | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The element the layer follows in the container: the view's text field after the canvas. */
    private readonly anchor: HTMLElement,
    private readonly worker: Worker,
    private readonly viewId: number,
  ) {
    this.layer.setAttribute('data-bl-tiles', String(viewId));
    this.hostLayers = new HostLayers(this.layer, worker, viewId);
  }

  /** The host layers the engine wants now (event `layers`). */
  setHostLayers(keep: readonly number[], add: readonly HostLayerRequest[]): void {
    this.hostLayers.update(keep, add);
    this.place();
  }

  /** New canvases for these tiles; a new size replaces all tiles of the old one. */
  add(size: number, keys: readonly number[]): void {
    if (size !== this.size) {
      for (const tile of this.tiles.values()) tile.remove();
      this.tiles.clear();
      this.size = size;
    }
    for (const key of keys) {
      // The engine asks only for tiles it has no canvas of (a new compositor after a GPU loss)
      this.tiles.get(key)?.remove();
      const tile = document.createElement('canvas');
      tile.width = size;
      tile.height = size;
      tile.style.cssText =
        `position:absolute;left:${columnOf(key) * size}px;top:${rowOf(key) * size}px;` +
        `width:${size}px;height:${size}px;object-fit:none;object-position:0 0;`;
      this.layer.append(tile);
      this.tiles.set(key, tile);
      const offscreen = tile.transferControlToOffscreen();
      this.worker.postMessage({ blTile: offscreen, viewId: this.viewId, size, key }, [offscreen]);
    }
    this.place();
  }

  /**
   * Puts the layer over the view canvas, in the same box and with the same scale (a frame pixel
   * per device pixel, view.ts), or takes it out when the canvas is not in a container.
   */
  place(): void {
    const { canvas, layer } = this;
    const parent = canvas.parentElement;
    if (
      !parent ||
      this.anchor.parentElement !== parent ||
      (!this.tiles.size && !this.hostLayers.size)
    ) {
      this.observer.disconnect();
      this.observed = null;
      layer.remove();
      return;
    }
    // Above the canvas, below what the host puts into the container later
    if (this.anchor.nextElementSibling !== layer) this.anchor.after(layer);
    // Size and margin of the canvas follow its container (an observation starts with a call)
    if (this.observed !== parent) {
      this.observer.disconnect();
      this.observer.observe(canvas);
      this.observer.observe(parent);
      this.observed = parent;
    }
    layer.style.cssText = [
      'position:absolute',
      // The z-index of the host layers stays inside
      'isolation:isolate',
      'overflow:hidden',
      'pointer-events:none',
      'margin:0',
      'padding:0',
      'border:0',
      'transform-origin:0 0',
      `left:${canvas.offsetLeft + canvas.clientLeft}px`,
      `top:${canvas.offsetTop + canvas.clientTop}px`,
      `width:${canvas.clientWidth}px`,
      `height:${canvas.clientHeight}px`,
      `transform:${canvas.style.transform}`,
      `display:${canvas.style.display === 'none' ? 'none' : 'block'}`,
    ].join(';');
  }

  /**
   * Draws what the tiles and host layers show over a copy of the view canvas drawn at `1 / ratio`
   * (debug).
   */
  drawOver(context: CanvasRenderingContext2D, ratio: number): void {
    for (const [key, tile] of this.tiles) {
      const x = (columnOf(key) * this.size) / ratio;
      const y = (rowOf(key) * this.size) / ratio;
      context.drawImage(tile, x, y, tile.width / ratio, tile.height / ratio);
    }
    this.hostLayers.drawOver(context, ratio);
  }

  /** The view is closed. */
  remove(): void {
    this.observer.disconnect();
    this.observed = null;
    this.layer.remove();
    this.tiles.clear();
    this.hostLayers.remove();
  }
}
