import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSeparator } from '../dist/context-menu.js';
import { createUiSlots, slotMenuItems } from '../dist/index.js';
import { fakeView } from './fake-view.mjs';

const info = { x: 0, y: 0, link: 'https://a.test/', image: '', selection: '', editable: false };

test('slots keep their items in order, refuse a taken id and report changes', () => {
  const slots = createUiSlots();
  const changes = [];
  slots.on('change', ({ slot }) => changes.push(slot));
  const a = { id: 'a', label: 'A', action() {} };
  const b = { id: 'b', label: 'B', action() {} };
  const removeA = slots.add('toolbar', a);
  slots.add('toolbar', b);
  slots.add('settings', { id: 'a', title: 'A', render() {} });
  assert.throws(() => slots.add('toolbar', { ...a }));
  assert.deepEqual(slots.items('toolbar'), [a, b]);
  removeA();
  removeA();
  assert.deepEqual(slots.items('toolbar'), [b]);
  assert.deepEqual(slots.items('panel'), []);
  assert.deepEqual(changes, ['toolbar', 'toolbar', 'settings', 'toolbar']);
});

test('openPanel asks the app', () => {
  const slots = createUiSlots();
  const opened = [];
  const stop = slots.on('open-panel', ({ id }) => opened.push(id));
  slots.openPanel('notes');
  stop();
  slots.openPanel('other');
  assert.deepEqual(opened, ['notes']);
});

test('context menu entries: only those that apply, after a separator', async () => {
  const slots = createUiSlots();
  const view = fakeView();
  assert.deepEqual(slotMenuItems(slots, view, info), []);
  const ran = [];
  slots.add('context-menu', {
    id: 'save-link',
    label: 'Save link',
    when: (menu) => !!menu.link,
    action: (target, menu) => ran.push([target, menu.link]),
  });
  slots.add('context-menu', { id: 'never', label: 'Never', when: () => false, action() {} });
  slots.add('context-menu', {
    id: 'broken',
    label: 'Broken',
    when: () => {
      throw new Error('no');
    },
    action() {},
  });
  const items = slotMenuItems(slots, view, info);
  assert.equal(items.length, 2);
  assert.ok(isSeparator(items[0]));
  assert.equal(items[1].id, 'save-link');
  await items[1].action();
  assert.deepEqual(ran, [[view, 'https://a.test/']]);
});
