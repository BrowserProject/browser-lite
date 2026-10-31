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

/** WebCore's fling (ScrollAnimationKinetic) travels the velocity (px/s) divided by this. */
const ENGINE_FRICTION = 4;
/** Android's fling curve (OverScroller), which Chrome on Android uses: its friction in px. */
const ANDROID_FRICTION = 0.015 * 9.80665 * 39.37 * 160 * 0.84;
const ANDROID_EXPONENT = Math.log(0.78) / Math.log(0.9) / (Math.log(0.78) / Math.log(0.9) - 1);

/**
 * The velocity (px/s) to give the engine for a fling of the finger at `velocity` px/ms, so it
 * travels as far as in Chrome on Android: there fast flings go further than in proportion.
 */
export function engineFlingVelocity(velocity: { x: number; y: number }): { x: number; y: number } {
  const speed = Math.hypot(velocity.x, velocity.y) * 1000;
  if (!speed) return { x: 0, y: 0 };
  const distance = ANDROID_FRICTION * ((0.35 * speed) / ANDROID_FRICTION) ** ANDROID_EXPONENT;
  const scale = (distance * ENGINE_FRICTION) / speed;
  return { x: velocity.x * 1000 * scale, y: velocity.y * 1000 * scale };
}
