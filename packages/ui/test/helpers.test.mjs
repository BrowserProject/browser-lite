import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateTimeType, stepAttribute } from '../dist/datetime.js';
import { defaultTexts } from '../dist/index.js';
import { createTypeahead, moveHighlight } from '../dist/select-keys.js';
import { format, hostOf, resolveTexts } from '../dist/texts.js';

test('resolveTexts keeps English defaults and merges permission texts', () => {
  const texts = resolveTexts({
    allow: 'Erlauben',
    permissions: { camera: '{host} will die Kamera' },
  });
  assert.equal(texts.allow, 'Erlauben');
  assert.equal(texts.block, 'Block');
  assert.equal(texts.permissions.camera, '{host} will die Kamera');
  assert.equal(texts.permissions.geolocation, defaultTexts.permissions.geolocation);
  assert.equal(resolveTexts().leaveSite, 'Leave site?');
  assert.ok(Object.isFrozen(defaultTexts));
});

test('format replaces known placeholders only', () => {
  assert.equal(format('{host} says: {x}', { host: 'a.com' }), 'a.com says: {x}');
});

test('hostOf', () => {
  assert.equal(hostOf('https://example.com'), 'example.com');
  assert.equal(hostOf('http://localhost:8080'), 'localhost:8080');
  assert.equal(hostOf('null'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf('file://'), 'file://');
});

test('stepAttribute converts the engine step to attribute units', () => {
  assert.equal(stepAttribute('date', 86_400_000), '1');
  assert.equal(stepAttribute('date', 7 * 86_400_000), '7');
  assert.equal(stepAttribute('date', 1), 'any');
  assert.equal(stepAttribute('week', 2 * 604_800_000), '2');
  assert.equal(stepAttribute('month', 3), '3');
  assert.equal(stepAttribute('time', 60_000), '60');
  assert.equal(stepAttribute('time', 900_000), '900');
  assert.equal(stepAttribute('time', 1), '0.001');
  assert.equal(stepAttribute('datetime-local', 1000), '1');
  assert.equal(stepAttribute('date', 0), '');
  assert.equal(stepAttribute('date', Number.NaN), '');
});

test('dateTimeType', () => {
  for (const type of ['date', 'time', 'datetime-local', 'month', 'week'])
    assert.equal(dateTimeType(type), type);
  assert.equal(dateTimeType('datetime'), 'date');
});

test('moveHighlight clamps to the entries', () => {
  assert.equal(moveHighlight('ArrowDown', 0, 3), 1);
  assert.equal(moveHighlight('ArrowDown', 2, 3), 2);
  assert.equal(moveHighlight('ArrowUp', 0, 3), 0);
  assert.equal(moveHighlight('PageDown', 1, 30), 11);
  assert.equal(moveHighlight('PageDown', 25, 30), 29);
  assert.equal(moveHighlight('PageUp', 5, 30), 0);
  assert.equal(moveHighlight('Home', 7, 30), 0);
  assert.equal(moveHighlight('End', 7, 30), 29);
  assert.equal(moveHighlight('a', 7, 30), null);
  assert.equal(moveHighlight('ArrowDown', -1, 0), -1, 'no entries');
});

test('typeahead matches prefixes and starts over after a pause', async () => {
  const texts = ['apple', 'banana', 'blueberry', 'cherry'];
  const typeahead = createTypeahead(50);
  assert.equal(typeahead.type('b', texts), 1);
  assert.equal(typeahead.type('L', texts), 2);
  assert.equal(typeahead.type('x', texts), -1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(typeahead.type('c', texts), 3);
  typeahead.reset();
  assert.equal(typeahead.type('a', texts), 0);
  typeahead.reset();
});
