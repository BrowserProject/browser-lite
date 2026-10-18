import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateTimeType, isoWeek, stepAttribute, valueFromNumber } from '../dist/datetime.js';
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

test('valueFromNumber for every date and time type', () => {
  const day = Date.UTC(2024, 1, 29);
  assert.equal(valueFromNumber('date', day), '2024-02-29');
  assert.equal(valueFromNumber('date', 0), '1970-01-01');
  assert.equal(valueFromNumber('date', Date.UTC(-5, 0, 1)), '-0005-01-01');
  assert.equal(
    valueFromNumber('datetime-local', day + 13 * 3_600_000 + 5 * 60_000),
    '2024-02-29T13:05',
  );
  assert.equal(valueFromNumber('datetime-local', day + 1000 + 7), '2024-02-29T00:00:01.007');
  assert.equal(valueFromNumber('datetime-local', day + 1000 + 70), '2024-02-29T00:00:01.07');
  assert.equal(valueFromNumber('time', 9 * 3_600_000 + 30 * 60_000), '09:30');
  assert.equal(valueFromNumber('time', 23 * 3_600_000 + 59 * 60_000 + 59_000), '23:59:59');
  assert.equal(valueFromNumber('time', 500), '00:00:00.500');
  assert.equal(valueFromNumber('month', 0), '1970-01');
  assert.equal(valueFromNumber('month', (2024 - 1970) * 12 + 11), '2024-12');
  assert.equal(valueFromNumber('month', -1), '1969-12');
  assert.equal(valueFromNumber('week', Date.UTC(2024, 0, 1)), '2024-W01');
  assert.equal(valueFromNumber('week', Date.UTC(2020, 11, 28)), '2020-W53');
  assert.equal(valueFromNumber('week', Date.UTC(2019, 11, 30)), '2020-W01');
  assert.equal(valueFromNumber('week', Date.UTC(2021, 0, 4)), '2021-W01');
  assert.equal(valueFromNumber('unknown', day), '2024-02-29', 'falls back to date');
  assert.equal(valueFromNumber('date', Number.NaN), '');
  assert.equal(valueFromNumber('date', 1e20), '');
});

test('isoWeek across year boundaries', () => {
  assert.deepEqual(isoWeek(Date.UTC(2016, 0, 3)), [2015, 53]);
  assert.deepEqual(isoWeek(Date.UTC(2026, 9, 18)), [2026, 42]);
  assert.deepEqual(isoWeek(Date.UTC(2026, 9, 18, 23, 59)), [2026, 42]);
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
