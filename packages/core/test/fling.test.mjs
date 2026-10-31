// Momentum after swipes: velocity of the finger and the decay of the fling.
import assert from 'node:assert/strict';
import test from 'node:test';
import { flingCurve, VelocityTracker } from '../dist/services/devices/fling.js';

/** Total distance of a fling at a frame rate (frames every `frame` ms). */
function distance(velocity, frame) {
  const curve = flingCurve(0, velocity);
  let total = 0;
  for (let t = frame; ; t += frame) {
    const step = curve(t);
    if (!step) return total;
    total += step.y;
  }
}

test('fling: steady swipe, the velocity of the finger', () => {
  const tracker = new VelocityTracker();
  for (let t = 0; t <= 300; t += 10) tracker.add(t, 100, 600 - t);
  const v = tracker.release(305, 100, 295);
  assert.ok(Math.abs(v.y + 1) < 0.01, String(v.y));
  assert.equal(v.x, 0);
});

test('fling: moves in a burst do not count as fast', () => {
  // The driver or a coalescing browser delivers 300 px within 2 ms after a slow start
  const tracker = new VelocityTracker();
  tracker.add(0, 100, 600);
  tracker.add(400, 100, 590);
  tracker.add(401, 100, 450);
  const v = tracker.release(402, 100, 300);
  assert.ok(Math.abs(v.y) < 3, String(v.y));
});

test('fling: a finger that rested before it lifted does not fling', () => {
  const tracker = new VelocityTracker();
  for (let t = 0; t <= 100; t += 10) tracker.add(t, 100, 600 - 3 * t);
  const v = tracker.release(250, 100, 300);
  assert.equal(v.y, 0);
});

test('fling: at most 8 px/ms', () => {
  const tracker = new VelocityTracker();
  tracker.add(0, 0, 0);
  const v = tracker.release(10, 0, 1000);
  assert.ok(Math.abs(v.y - 8) < 1e-9, String(v.y));
});

test('fling: same distance at any frame rate, about 325 ms of the velocity', () => {
  const at60 = distance({ x: 0, y: 2 }, 1000 / 60);
  const at120 = distance({ x: 0, y: 2 }, 1000 / 120);
  assert.ok(Math.abs(at60 - at120) < 1, `${at60} ${at120}`);
  assert.ok(at60 > 600 && at60 < 650, String(at60));
  assert.equal(flingCurve(0, { x: 0, y: 0.001 })(16), null);
});
