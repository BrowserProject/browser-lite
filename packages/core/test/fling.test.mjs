// Velocity of the finger for the fling after a swipe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VelocityTracker } from '../dist/services/devices/fling.js';

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
