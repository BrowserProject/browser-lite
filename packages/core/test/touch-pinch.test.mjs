// Two fingers zoom once the page answered both touchstarts; the movement until then is kept.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TouchPinch } from '../dist/services/devices/touch-pinch.js';

// Fingers 100 px apart around (200, 300) and a recorder of the steps for the engine
const start = () => {
  const fingers = [
    { x: 150, y: 300 },
    { x: 250, y: 300 },
  ];
  const steps = [];
  const pinch = new TouchPinch(fingers, (...step) => steps.push(step));
  const spread = (distance) => {
    fingers[0].x = 200 - distance / 2;
    fingers[1].x = 200 + distance / 2;
    pinch.moved();
  };
  // The product of the steps: the scale the engine shows
  const scale = () => steps.filter(([phase]) => phase === 1).reduce((s, [, f]) => s * f, 1);
  return { fingers, steps, pinch, spread, scale };
};
const allow = (fingers, ...answers) => {
  for (const [i, answer] of answers.entries()) fingers[i].pinch = answer;
};

test('touch pinch: answered at once, the zoom follows the fingers', () => {
  const { fingers, steps, pinch, spread, scale } = start();
  allow(fingers, true, true);
  pinch.answered();
  assert.deepEqual(steps[0], [0, 1, 200, 300]);
  spread(150);
  spread(200);
  pinch.lift(false);
  assert.ok(Math.abs(scale() - 2) < 1e-9);
  assert.equal(steps.at(-1)[0], 2);
});

test('touch pinch: the answers come after the fingers lifted, the whole zoom catches up', () => {
  const { fingers, steps, pinch, spread, scale } = start();
  spread(150);
  spread(300);
  pinch.lift(false);
  assert.equal(steps.length, 0);
  allow(fingers, true, true);
  pinch.answered();
  assert.deepEqual(
    steps.map(([phase]) => phase),
    [0, 1, 2],
  );
  // Begins where the fingers came down, ends where they lifted
  assert.deepEqual(steps[0], [0, 1, 200, 300]);
  assert.ok(Math.abs(scale() - 3) < 1e-9);
});

test('touch pinch: the answers come in the middle, nothing of the movement is lost', () => {
  const { fingers, pinch, spread, scale } = start();
  spread(160);
  allow(fingers, true, true);
  pinch.answered();
  spread(250);
  pinch.lift(false);
  assert.ok(Math.abs(scale() - 2.5) < 1e-9);
});

test('touch pinch: touch-action or preventDefault of a touchstart, no zoom', () => {
  for (const answers of [
    [true, false],
    [false, true],
  ]) {
    const { fingers, steps, pinch, spread } = start();
    spread(200);
    allow(fingers, ...answers);
    pinch.answered();
    spread(300);
    pinch.lift(false);
    assert.equal(steps.length, 0);
  }
});

test('touch pinch: preventDefault on a touchmove takes the view back', () => {
  const { fingers, steps, pinch, spread } = start();
  allow(fingers, true, true);
  pinch.answered();
  spread(200);
  pinch.cancel();
  spread(300);
  pinch.lift(false);
  assert.deepEqual(
    steps.map(([phase]) => phase),
    [0, 1, 3],
  );
});

test('touch pinch: cancelled fingers before the answers, no zoom', () => {
  const { fingers, steps, pinch, spread } = start();
  spread(200);
  pinch.lift(true);
  allow(fingers, true, true);
  pinch.answered();
  assert.equal(steps.length, 0);
});
