/** A finger of a pinch: where it is (CSS px in the view) and whether the page lets it zoom. */
export interface PinchFinger {
  x: number;
  y: number;
  /** The answer to its touchstart: touch-action allows zooming and no preventDefault; unset until then. */
  pinch?: boolean;
}

/** A step for the engine (bl_pinch): phase 0 begin, 1 step (factor relative to the last), 2 end, 3 cancel. */
export type PinchStep = (phase: number, factor: number, x: number, y: number) => void;

interface Span {
  x: number;
  y: number;
  distance: number;
}

const span = ([a, b]: readonly [PinchFinger, PinchFinger]): Span => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  distance: Math.hypot(a.x - b.x, a.y - b.y),
});

/**
 * Two fingers zoom the view like Chrome, once the page answered both touchstarts (no
 * preventDefault, touch-action allows zooming). Until then the movement of the fingers is kept
 * and the zoom catches up with it when the answers come, also after the fingers lifted: a pinch
 * while the page's JS keeps the engine thread busy is not lost.
 */
export class TouchPinch {
  private state: 'waiting' | 'zooming' | 'done' = 'waiting';
  private lifted = false;
  /** The fingers as the engine knows them: where they came down until the zoom began. */
  private shown: Span;

  constructor(
    /** The two fingers; they keep their last position after they lifted. */
    readonly fingers: readonly [PinchFinger, PinchFinger],
    private readonly step: PinchStep,
  ) {
    this.shown = span(fingers);
  }

  /** Both touchstarts are answered (the second finger's answer came): zoom if both may. */
  answered(): void {
    if (this.state !== 'waiting') return;
    if (!this.fingers.every((finger) => finger.pinch)) {
      this.state = 'done';
      return;
    }
    this.state = 'zooming';
    this.step(0, 1, this.shown.x, this.shown.y);
    this.moved();
    if (this.lifted) this.finish(2);
  }

  /** A finger moved: the zoom follows while it runs. */
  moved(): void {
    if (this.state !== 'zooming') return;
    const now = span(this.fingers);
    if (now.x === this.shown.x && now.y === this.shown.y && now.distance === this.shown.distance)
      return;
    if (this.shown.distance > 0 && now.distance > 0)
      this.step(1, now.distance / this.shown.distance, now.x, now.y);
    this.shown = now;
  }

  /** A finger lifted (or was cancelled): the gesture ends, or ends once the answers came. */
  lift(cancelled: boolean): void {
    this.moved();
    if (cancelled) this.cancel();
    else if (this.state === 'zooming') this.finish(2);
    else this.lifted = true;
  }

  /** The page takes the fingers (preventDefault): the view goes back to the start. */
  cancel(): void {
    if (this.state === 'zooming') this.finish(3);
    this.state = 'done';
  }

  private finish(phase: number): void {
    this.step(phase, 1, this.shown.x, this.shown.y);
    this.state = 'done';
  }
}
