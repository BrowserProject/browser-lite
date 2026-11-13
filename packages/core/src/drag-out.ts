/** A drag the page of a view started (engine event `page-drag-start`). */
export interface PageDrag {
  /** The data of its DataTransfer, in the order of setData. */
  items: { type: string; data: string }[];
  /** Its effectAllowed (HTML drag and drop names). */
  effectAllowed: string;
}

/** What `release` decided: not over the embedding page, or dropped there with this effect. */
export type DragOutResult = null | { dropEffect: 'copy' | 'link' | 'move' | 'none' };

const CURSORS: Record<string, string> = { copy: 'copy', link: 'alias', move: 'move' };

/** The effect a target that accepts gets when it set none itself: copy, else link, else move. */
export function defaultEffect(effectAllowed: string): 'copy' | 'link' | 'move' | 'none' {
  const allowed = effectAllowed.toLowerCase();
  if (allowed === 'all' || allowed === 'uninitialized' || allowed.includes('copy')) return 'copy';
  if (allowed.includes('link')) return 'link';
  if (allowed.includes('move')) return 'move';
  return 'none';
}

/** Whether effectAllowed allows the drop effect `effect`. */
function allows(effectAllowed: string, effect: string): boolean {
  const allowed = effectAllowed.toLowerCase();
  return allowed === 'all' || allowed === 'uninitialized' || allowed.includes(effect);
}

/** The innermost element at a point, also inside open shadow roots. */
function elementAt(x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

/**
 * The part of a page's drag that leaves the view for the embedding page, like a system drag in
 * Chrome that reaches the tab strip, the address bar or another window. Over an element of the
 * embedding page it gets dragenter, dragover and dragleave and, when its last dragover called
 * preventDefault, drop: untrusted DragEvents with a new DataTransfer holding the page's data in
 * every event. The caller sends the page a point outside the view meanwhile, so the page's drop
 * targets see the drag leave, and ends the page's drag with the result of `release`.
 */
export class DragOut {
  private drag: PageDrag | null = null;
  private target: Element | null = null;
  private effect: 'copy' | 'link' | 'move' | 'none' = 'none';
  private savedCursor: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** The page started a drag. */
  start(drag: PageDrag): void {
    this.leave();
    this.drag = drag;
  }

  /** The page's drag ended in the engine (dropped in the view, Escape, a new page). */
  end(): void {
    this.leave();
    this.drag = null;
  }

  /**
   * A move with a button held: true while a page's drag is over an element of the embedding page
   * (then the page must see the pointer outside the view).
   */
  move(e: PointerEvent): boolean {
    if (!this.drag) return false;
    const target = this.targetAt(e);
    if (target !== this.target) {
      this.leave();
      if (!target) return false;
      this.target = target;
      this.savedCursor = this.canvas.style.cursor;
      this.fire('dragenter', target, e);
    }
    if (!target) return false;
    const accepted = this.fire('dragover', target, e);
    this.effect = accepted ? accepted : 'none';
    // The pointer is captured by the view canvas, which shows the cursor
    this.canvas.style.cursor = CURSORS[this.effect] ?? 'no-drop';
    return true;
  }

  /**
   * The button was released: null when the page's drag is not over the embedding page (the page
   * handles the release), else the drop effect after drop went to the target.
   */
  release(e: PointerEvent): DragOutResult {
    // The target at the release point gets a last dragover first
    const target = this.move(e) && this.target;
    if (!target) return null;
    const dropEffect = this.effect;
    if (dropEffect !== 'none') this.fire('drop', target, e);
    else this.fire('dragleave', target, e);
    this.target = null;
    this.restoreCursor();
    this.drag = null;
    return { dropEffect };
  }

  private targetAt(e: PointerEvent): Element | null {
    const element = elementAt(e.clientX, e.clientY);
    return element === this.canvas ? null : element;
  }

  private leave(): void {
    const target = this.target;
    if (!target) return;
    this.target = null;
    this.effect = 'none';
    this.restoreCursor();
    this.fire('dragleave', target, null);
  }

  private restoreCursor(): void {
    if (this.savedCursor === null) return;
    this.canvas.style.cursor = this.savedCursor;
    this.savedCursor = null;
  }

  /**
   * Sends a drag event to target; for dragover the effect when it called preventDefault (the
   * target's dropEffect if allowed, else the default of effectAllowed), else false.
   */
  private fire(
    type: string,
    target: Element,
    e: PointerEvent | null,
  ): 'copy' | 'link' | 'move' | false {
    const drag = this.drag;
    if (!drag) return false;
    let transfer: DataTransfer;
    try {
      transfer = new DataTransfer();
      for (const { type: itemType, data } of drag.items) transfer.setData(itemType, data);
    } catch {
      return false; // a browser without the DataTransfer constructor
    }
    // Chrome ignores both on a constructed DataTransfer, Firefox takes them
    try {
      transfer.effectAllowed = drag.effectAllowed as DataTransfer['effectAllowed'];
      if (type === 'dragover' || type === 'drop') {
        const effect = type === 'drop' ? this.effect : defaultEffect(drag.effectAllowed);
        transfer.dropEffect = effect as DataTransfer['dropEffect'];
      }
    } catch {}
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: type !== 'dragleave',
      composed: true,
      dataTransfer: transfer,
      clientX: e?.clientX ?? 0,
      clientY: e?.clientY ?? 0,
      screenX: e?.screenX ?? 0,
      screenY: e?.screenY ?? 0,
      shiftKey: e?.shiftKey ?? false,
      ctrlKey: e?.ctrlKey ?? false,
      altKey: e?.altKey ?? false,
      metaKey: e?.metaKey ?? false,
      buttons: e?.buttons ?? 0,
    });
    const notCanceled = target.dispatchEvent(event);
    if (type !== 'dragover' || notCanceled) return false;
    const chosen = transfer.dropEffect;
    if (chosen !== 'none' && allows(drag.effectAllowed, chosen)) return chosen;
    const effect = defaultEffect(drag.effectAllowed);
    return effect === 'none' ? false : effect;
  }
}
