/** Movement of the finger in this many ms before it lifts decides the fling velocity. */
const WINDOW = 100;
/** Time constant of the decay in ms: a fling scrolls `velocity * DECAY` pixels in total. */
const DECAY = 325;
/** Fastest fling in px/ms, like Android's maximum fling velocity. */
const MAX_VELOCITY = 8;
/** Slower than this (px/ms) the fling stops. */
const MIN_VELOCITY = 0.02;

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

/**
 * Momentum after a swipe: the velocity decays exponentially over time (not per frame, so the
 * distance is the same at any frame rate). Returns the distance to scroll for a frame at time t,
 * or null when the fling is over.
 */
export function flingCurve(start: number, velocity: { x: number; y: number }) {
  let vx = velocity.x;
  let vy = velocity.y;
  let last = start;
  return (t: number): { x: number; y: number } | null => {
    if (Math.hypot(vx, vy) < MIN_VELOCITY) return null;
    const decay = Math.exp(-Math.max(0, t - last) / DECAY);
    last = Math.max(last, t);
    const step = { x: vx * DECAY * (1 - decay), y: vy * DECAY * (1 - decay) };
    vx *= decay;
    vy *= decay;
    return step;
  };
}
