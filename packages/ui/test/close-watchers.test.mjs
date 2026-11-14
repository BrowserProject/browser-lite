import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeNewest, closeWatched, onCloseWatchedChange, watchClose } from '../dist/index.js';

test('a close request closes the newest overlay, then the one below', () => {
  const closed = [];
  const changes = [];
  const stopListening = onCloseWatchedChange(() => changes.push(closeWatched()));
  assert.equal(closeWatched(), false);
  assert.equal(closeNewest(), false);

  const stops = {};
  for (const name of ['menu', 'popup'])
    stops[name] = watchClose(() => {
      closed.push(name);
      // An overlay ends its registration when it closes, also when a close request closed it
      stops[name]();
    });
  assert.equal(closeWatched(), true);
  assert.equal(closeNewest(), true);
  assert.deepEqual(closed, ['popup']);
  assert.equal(closeWatched(), true);

  // Closed by itself (a tap outside): not closed again, not counted twice
  stops.menu();
  stops.menu();
  assert.equal(closeWatched(), false);
  assert.equal(closeNewest(), false);
  assert.deepEqual(closed, ['popup']);
  assert.deepEqual(changes, [true, true, true, false]);

  stopListening();
  watchClose(() => {})();
  assert.equal(changes.length, 4);
});

test('the same function registered twice is two overlays', () => {
  let count = 0;
  const close = () => count++;
  watchClose(close);
  const second = watchClose(close);
  second();
  assert.equal(closeNewest(), true);
  assert.equal(count, 1);
  assert.equal(closeWatched(), false);
});
