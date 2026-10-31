/** Movement of the finger in this many ms before it lifts decides the fling velocity. */
const WINDOW = 100;
/** Fastest fling in px/ms, like Android's maximum fling velocity. */
const MAX_VELOCITY = 8;

interface Sample {
  t: number;
  x: number;
  y: number;
}

/**
 * Velocity of a swipe from the positions of the finger over time: the movement since the last
 * position at least 100 ms before the finger lifted. Moves that arrive in a burst do not count as
 * fast and a finger that rested before it lifted does not fling.
 */
export class VelocityTracker {
  private samples: Sample[] = [];

  /** Position of the finger at time t (ms). */
  add(t: number, x: number, y: number): void {
    this.samples.push({ t, x, y });
    // The first sample stays the last one at or before the start of the window
    while (this.samples.length > 2 && (this.samples[1] as Sample).t <= t - WINDOW)
      this.samples.shift();
  }

  /** Velocity in px/ms when the finger lifts at time t at x, y, at most 8 px/ms. */
  release(t: number, x: number, y: number): { x: number; y: number } {
    this.add(t, x, y);
    const from = this.samples[0] as Sample;
    const dt = t - from.t;
    if (dt <= 0) return { x: 0, y: 0 };
    const vx = (x - from.x) / dt;
    const vy = (y - from.y) / dt;
    const scale = Math.min(1, MAX_VELOCITY / Math.max(Math.hypot(vx, vy), 1e-9));
    return { x: vx * scale, y: vy * scale };
  }
}
