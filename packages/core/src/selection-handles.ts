// Selection handles like Chrome on phones and Safari: a selection a long press made gets two
// handles over the view, at the bottom of the caret lines of its start and end (engine event
// `touch-selection`). Dragging one moves that end of the selection (bl_selection_handle) along
// with the finger; on release the engine opens the menu of the selection, like Chrome's after a
// handle drag. The handles lie in a layer over the canvas like the damage tiles (view-tiles.ts).

import type { Rect } from './types.js';
import type { ViewImpl } from './view.js';

/** One end of the selection: its caret line in CSS pixels of the view. */
interface Edge {
  x: number;
  y: number;
  height: number;
  visible: boolean;
}

/** A handle the finger holds, with the distance from the finger to the middle of its line. */
interface Drag {
  handle: 0 | 1;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  height: number;
  x: number;
  y: number;
  sent: boolean;
}

// Diameter of the drawn handle and the side of its touch area (CSS pixels)
const SIZE = 22;
const TOUCH = 44;

function edgeOf(value: unknown): Edge | null {
  if (!value || typeof value !== 'object') return null;
  const edge = value as Record<string, unknown>;
  const x = Number(edge.x);
  const y = Number(edge.y);
  const height = Number(edge.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(height)) return null;
  return { x, y, height, visible: edge.visible !== false };
}

/** The selection handles of one view. */
export class SelectionHandles {
  private readonly layer = document.createElement('div');
  private readonly handles: [HTMLElement, HTMLElement];
  private edges: [Edge, Edge] | null = null;
  private drag: Drag | null = null;
  private frame = 0;

  constructor(
    private readonly view: ViewImpl,
    /** The element the layer follows in the container: the view's text field after the canvas. */
    private readonly anchor: HTMLElement,
    signal: AbortSignal,
  ) {
    this.layer.setAttribute('data-bl-selection-handles', String(view.id));
    this.handles = [this.createHandle(0, signal), this.createHandle(1, signal)];
    signal.addEventListener('abort', () => {
      cancelAnimationFrame(this.frame);
      this.layer.remove();
    });
  }

  /** Event `touch-selection`: the edges of the selection, or `{}` without handles. */
  update(data: Record<string, unknown>): void {
    const start = edgeOf(data.start);
    const end = edgeOf(data.end);
    this.edges = start && end ? [start, end] : null;
    if (!this.edges) this.endDrag();
    this.place();
  }

  /**
   * The selection with its handles below it (CSS pixels of the view), null without handles: the
   * area a menu of the selection keeps clear of.
   */
  bounds(): Rect | null {
    const edges = this.edges;
    if (!edges || !this.layer.isConnected) return null;
    const [start, end] = edges;
    const left = Math.min(start.x, end.x) - SIZE;
    const right = Math.max(start.x, end.x) + SIZE;
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y + start.height, end.y + end.height) + SIZE;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Puts the layer over the canvas and the handles at the edges (also after a resize). */
  place(): void {
    const { layer, view, anchor } = this;
    const canvas = view.canvas;
    const parent = canvas.parentElement;
    if (!this.edges || !parent || anchor.parentElement !== parent) {
      layer.remove();
      return;
    }
    // Above the canvas and its damage tiles, below what the host puts into the container later;
    // moved only when out of order, since a move ends the pointer capture of a dragged handle
    const after = parent.querySelector(`:scope > [data-bl-tiles="${view.id}"]`) ?? anchor;
    if (
      layer.parentElement !== parent ||
      !(after.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
      after.after(layer);
    layer.style.cssText = [
      'position:absolute',
      'margin:0',
      'padding:0',
      'border:0',
      'width:0',
      'height:0',
      `left:${canvas.offsetLeft}px`,
      `top:${canvas.offsetTop}px`,
      `display:${canvas.style.display === 'none' ? 'none' : 'block'}`,
    ].join(';');
    const { width, height } = view.viewSize;
    this.handles.forEach((element, index) => {
      const edge = (this.edges as [Edge, Edge])[index] as Edge;
      const drag = this.drag?.handle === index ? this.drag : null;
      // The tip of the handle: the bottom of the caret line, under the finger while dragged
      const x = drag ? drag.x : edge.x;
      const y = drag ? drag.y + drag.height / 2 : edge.y + edge.height;
      const shown =
        !!drag || (edge.visible && x >= -1 && x <= width + 1 && y >= 0 && y <= height + 1);
      element.style.display = shown ? 'block' : 'none';
      // The circle lies below the tip, left of it for the start and right of it for the end
      const centerX = index === 0 ? x - SIZE / 2 : x + SIZE / 2;
      const centerY = y + SIZE / 2;
      element.style.transform = `translate(${centerX - TOUCH / 2}px, ${centerY - TOUCH / 2}px)`;
    });
  }

  private createHandle(handle: 0 | 1, signal: AbortSignal): HTMLElement {
    const element = document.createElement('div');
    element.setAttribute('data-bl-selection-handle', handle === 0 ? 'start' : 'end');
    element.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      `width:${TOUCH}px`,
      `height:${TOUCH}px`,
      'touch-action:none',
      'user-select:none',
      '-webkit-user-select:none',
      '-webkit-touch-callout:none',
      '-webkit-tap-highlight-color:transparent',
      'cursor:grab',
    ].join(';');
    const drop = document.createElement('div');
    // A circle with the corner at the tip square, the color from --bl-selection-handle-color
    drop.style.cssText = [
      'position:absolute',
      `left:${(TOUCH - SIZE) / 2}px`,
      `top:${(TOUCH - SIZE) / 2}px`,
      `width:${SIZE}px`,
      `height:${SIZE}px`,
      `border-radius:${handle === 0 ? '50% 0 50% 50%' : '0 50% 50% 50%'}`,
      'background:var(--bl-selection-handle-color,#1a73e8)',
      'pointer-events:none',
    ].join(';');
    element.append(drop);
    this.layer.append(element);
    const options = { signal };
    element.addEventListener('pointerdown', (e) => this.down(handle, element, e), options);
    element.addEventListener('pointermove', (e) => this.move(e), options);
    element.addEventListener('pointerup', (e) => this.up(e, true), options);
    element.addEventListener('pointercancel', (e) => this.up(e, false), options);
    element.addEventListener('lostpointercapture', (e) => this.up(e, false), options);
    return element;
  }

  private down(handle: 0 | 1, element: HTMLElement, e: PointerEvent): void {
    const edge = this.edges?.[handle];
    if (!edge || !this.view.alive || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // A second finger leaves the drag alone; a new press of the same pointer ends a drag whose
    // release never came (a mouse let go outside the window)
    if (this.drag && e.pointerId !== this.drag.pointerId) return;
    this.endDrag();
    e.preventDefault();
    e.stopPropagation();
    element.setPointerCapture(e.pointerId);
    this.view.userInput(false);
    const [x, y] = this.view.position(e);
    // The finger keeps its distance to the middle of the line, which the engine looks at
    this.drag = {
      handle,
      pointerId: e.pointerId,
      offsetX: edge.x - x,
      offsetY: edge.y + edge.height / 2 - y,
      height: edge.height,
      x: edge.x,
      y: edge.y + edge.height / 2,
      sent: true,
    };
  }

  private move(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    const [x, y] = this.view.position(e);
    drag.x = x + drag.offsetX;
    drag.y = y + drag.offsetY;
    drag.sent = false;
    this.place();
    // One move per display frame, the newest
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.drag && !this.drag.sent) this.send(this.drag, false);
      });
  }

  private up(e: PointerEvent, released: boolean): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (released) {
      const [x, y] = this.view.position(e);
      drag.x = x + drag.offsetX;
      drag.y = y + drag.offsetY;
    }
    if (released || !drag.sent) this.send(drag, released);
    this.place();
  }

  private send(drag: Drag, done: boolean): void {
    drag.sent = true;
    this.view.selectionHandle(drag.handle, drag.x, drag.y, done);
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    const element = drag ? this.handles[drag.handle] : null;
    if (drag && element?.hasPointerCapture(drag.pointerId))
      element.releasePointerCapture(drag.pointerId);
  }
}
