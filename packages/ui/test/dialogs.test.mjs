import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answerAsk,
  countDialog,
  decideDialog,
  newDialogState,
  skipBeforeUnload,
} from '../dist/dialog-guard.js';
import { nativeDialogs } from '../dist/index.js';
import { fakeView } from './fake-view.mjs';

test('countDialog counts dialogs less than 1 s apart', () => {
  const state = newDialogState();
  assert.equal(countDialog(state, 10_000), 1);
  state.last = 10_000;
  assert.equal(countDialog(state, 10_500), 2);
  state.last = 10_500;
  assert.equal(countDialog(state, 11_499), 3);
  state.last = 11_499;
  assert.equal(countDialog(state, 12_499), 1, 'a gap of 1 s starts over');
});

test('decideDialog asks once at the fourth dialog in a burst', () => {
  const state = newDialogState();
  let now = 5000;
  const decisions = [];
  for (let i = 0; i < 6; i++) {
    const decision = decideDialog(state, now);
    decisions.push(decision);
    if (decision === 'ask') answerAsk(state, true);
    state.last = now;
    now += 100;
  }
  assert.deepEqual(decisions, ['show', 'show', 'show', 'ask', 'show', 'show']);
  const blocked = newDialogState();
  answerAsk(blocked, false);
  assert.equal(decideDialog(blocked, 0), 'skip');
});

test('skipBeforeUnload from the third question in a loop', () => {
  const state = newDialogState();
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(skipBeforeUnload(state, 1000 + i * 10));
    state.last = 1000 + i * 10;
  }
  assert.deepEqual(results, [false, false, true, true]);
  state.blocked = true;
  assert.equal(skipBeforeUnload(state, 1e9), true);
});

function setup(answers = {}) {
  const shown = [];
  const win = {
    alert: (text) => shown.push(['alert', text]),
    confirm: (text) => {
      shown.push(['confirm', text]);
      return answers.confirm?.(text) ?? true;
    },
    prompt: (text, value) => {
      shown.push(['prompt', text, value]);
      return answers.prompt ?? value;
    },
  };
  const root = { ownerDocument: { defaultView: win } };
  let now = 100_000;
  const blocked = [];
  const { dialog } = nativeDialogs({
    root,
    now: () => now,
    onBlocked: (view) => blocked.push(view.id),
    texts: answers.texts,
  });
  return { dialog, shown, blocked, tick: (ms) => (now += ms) };
}

const request = (view, type, extra = {}) => ({
  view,
  type,
  origin: 'https://example.com',
  message: 'Hello',
  defaultValue: 'x',
  reload: false,
  ...extra,
});

test('alert, confirm and prompt show the host prefix', () => {
  const { dialog, shown, tick } = setup({ prompt: 'typed' });
  const view = fakeView();
  assert.equal(dialog(request(view, 'alert')), undefined);
  tick(2000);
  assert.equal(dialog(request(view, 'confirm')), true);
  tick(2000);
  assert.equal(dialog(request(view, 'prompt')), 'typed');
  tick(2000);
  assert.equal(dialog(request(view, 'alert', { origin: 'null' })), undefined);
  assert.deepEqual(shown, [
    ['alert', 'example.com says:\n\nHello'],
    ['confirm', 'example.com says:\n\nHello'],
    ['prompt', 'example.com says:\n\nHello', 'x'],
    ['alert', 'This page says:\n\nHello'],
  ]);
});

test('beforeunload asks with the standard texts and never shows the page text', () => {
  const { dialog, shown, tick } = setup({ confirm: () => false });
  const view = fakeView();
  assert.equal(dialog(request(view, 'beforeunload', { message: 'page text' })), false);
  tick(5000);
  assert.equal(dialog(request(view, 'beforeunload', { reload: true })), false);
  assert.deepEqual(shown, [
    ['confirm', 'Leave site?\n\nChanges that you made may not be saved.'],
    ['confirm', 'Reload site?\n\nChanges that you made may not be saved.'],
  ]);
});

test('beforeunload in a navigation loop leaves without asking', () => {
  const { dialog, shown, tick } = setup({ confirm: () => false });
  const view = fakeView();
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(dialog(request(view, 'beforeunload')));
    tick(100);
  }
  assert.deepEqual(results, [false, false, true, true]);
  assert.equal(shown.length, 2);
});

test('a dialog loop asks once; blocking lasts until the next document', () => {
  const { dialog, shown, blocked, tick } = setup({
    confirm: (text) => !text.includes('many dialogs'),
  });
  const view = fakeView({ id: 7 });
  const other = fakeView({ id: 8 });
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(dialog(request(view, 'confirm')));
    tick(200);
  }
  assert.deepEqual(results, [true, true, true, false, false, false]);
  assert.equal(shown.filter(([, text]) => text.includes('many dialogs')).length, 1);
  assert.equal(
    shown.at(-1)[1],
    'example.com is showing many dialogs. Allow more dialogs from this site?',
  );
  assert.deepEqual(blocked, [7]);
  assert.equal(dialog(request(view, 'prompt')), null, 'blocked prompt answers null');
  assert.equal(dialog(request(view, 'alert')), undefined);
  assert.equal(dialog(request(view, 'beforeunload')), true, 'blocked beforeunload leaves');
  assert.equal(dialog(request(other, 'confirm')), true, 'other views are not affected');
  view.emit('commit', { errorPage: null });
  tick(5000);
  assert.equal(dialog(request(view, 'confirm')), true, 'new document shows dialogs again');
  assert.equal(view.listenerCount('commit'), 1, 'one commit listener per view');
});

test('allowing more dialogs keeps showing them without asking again', () => {
  const { dialog, shown, tick } = setup();
  const view = fakeView();
  for (let i = 0; i < 8; i++) {
    dialog(request(view, 'alert'));
    tick(10);
  }
  assert.equal(shown.filter(([type]) => type === 'alert').length, 8);
  assert.equal(shown.filter(([type]) => type === 'confirm').length, 1);
});

test('texts can be replaced', () => {
  const { dialog, shown } = setup({ texts: { dialogFrom: 'Von {host}:' } });
  dialog(request(fakeView(), 'alert'));
  assert.equal(shown[0][1], 'Von example.com:\n\nHello');
});
