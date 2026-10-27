// DeliveryWindow: how much the relay keeps on the way to an acknowledging client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryWindow, MIN_WINDOW } from '../dist/wisp/window.js';

test('no limit until the client acknowledges', () => {
  const window = new DeliveryWindow();
  window.onSent(10 * MIN_WINDOW, 0);
  assert.equal(window.full, false);
  assert.equal(window.open, true);
});

test('full beyond the window, open again at three quarters', () => {
  const window = new DeliveryWindow();
  window.onSent(100, 0);
  window.onAck(100, 50);
  window.onSent(MIN_WINDOW + 1, 60);
  assert.equal(window.full, true);
  window.onAck(100 + MIN_WINDOW / 2, 120);
  assert.equal(window.full, false);
  assert.equal(window.open, true);
});

test('acknowledgements beyond what was sent are ignored, the counter wraps at 2^32', () => {
  const window = new DeliveryWindow();
  window.onSent(1000, 0);
  window.onAck(5000, 10);
  assert.equal(window.inFlight, 1000);
  window.onAck(1000, 20);
  assert.equal(window.inFlight, 0);
  const wrapped = new DeliveryWindow();
  wrapped.onSent(2 ** 32 - 10, 0);
  wrapped.onAck((2 ** 32 - 10) >>> 0, 100);
  wrapped.onSent(20, 110);
  wrapped.onAck(10, 200);
  assert.equal(wrapped.inFlight, 0);
});

test('the window follows the delivery rate times the round trip', () => {
  const window = new DeliveryWindow();
  // A first exchange with little on the way measures the round trip (100 ms)
  window.onSent(1000, 0);
  window.onAck(1000, 100);
  // Then 1 MB per 100 ms (10 MB/s), acknowledged 100 ms later
  let sent = 1000;
  for (let t = 110; t <= 1100; t += 10) {
    window.onSent(100 * 1024, t);
    sent += 100 * 1024;
    if (t >= 210) window.onAck(sent - 1000 * 1024, t);
  }
  // About 2.5 x 10 MB/s x 100 ms, far above the minimum: 1 MB more on the way fits
  window.onSent(1024 * 1024, 1110);
  assert.equal(window.full, false);
  window.onSent(2 * 1024 * 1024, 1120);
  assert.equal(window.full, true);
});
