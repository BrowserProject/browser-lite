import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSeparator, normalizeMenu } from '../dist/context-menu.js';
import { defaultMenuItems } from '../dist/index.js';
import { fakeView } from './fake-view.mjs';

const info = (extra = {}) => ({
  x: 10,
  y: 20,
  link: '',
  image: '',
  selection: '',
  editable: false,
  canGoBack: false,
  canGoForward: false,
  ...extra,
});
const ids = (items) => items.map((item) => (isSeparator(item) ? '-' : item.id));

test('normalizeMenu drops leading, trailing and double separators', () => {
  const a = { label: 'a', action() {} };
  const b = { label: 'b', action() {} };
  const s = { separator: true };
  assert.deepEqual(normalizeMenu([s, a, s, s, b, s]), [a, s, b]);
  assert.deepEqual(normalizeMenu([s, s]), []);
  assert.deepEqual(normalizeMenu([]), []);
});

test('plain page: select all and navigation', () => {
  const items = defaultMenuItems(fakeView(), info({ canGoBack: true }), { openTab() {} });
  assert.deepEqual(ids(normalizeMenu(items)), [
    'select-all',
    '-',
    'back',
    'forward',
    'reload',
    'print',
    'view-source',
  ]);
  const byId = Object.fromEntries(
    items.filter((item) => !isSeparator(item)).map((item) => [item.id, item]),
  );
  assert.equal(byId.back.enabled, true);
  assert.equal(byId.forward.enabled, false);
  assert.equal(byId['view-source'].enabled, true);
  assert.deepEqual(
    items.filter((item) => !isSeparator(item)).map((item) => item.label),
    ['Select all', 'Back', 'Forward', 'Reload', 'Print…', 'View page source'],
  );
});

test('link, image, selection and editable field', async () => {
  const view = fakeView();
  const opened = [];
  const copied = [];
  const items = defaultMenuItems(
    view,
    info({
      link: 'https://l.test/',
      image: 'https://i.test/x.png',
      selection: 'sel',
      editable: true,
    }),
    {
      openTab: (url) => opened.push(url),
      copyText: (text) => copied.push(text),
      readText: async () => 'clip',
    },
  );
  assert.deepEqual(ids(normalizeMenu(items)), [
    'open-link',
    'copy-link',
    '-',
    'open-image',
    'copy-image',
    '-',
    'copy',
    'cut',
    'paste',
    'select-all',
    '-',
    'back',
    'forward',
    'reload',
    'print',
    'view-source',
  ]);
  const run = async (id) => items.find((item) => item.id === id).action();
  await run('open-link');
  await run('copy-link');
  await run('open-image');
  await run('copy-image');
  await run('copy');
  await run('cut');
  await run('paste');
  await run('select-all');
  await run('back');
  await run('forward');
  await run('reload');
  await run('print');
  await run('view-source');
  assert.deepEqual(opened, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(copied, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(view.calls, [
    ['command', 'Copy'],
    ['command', 'Cut'],
    ['paste', 'clip'],
    ['command', 'SelectAll'],
    ['back'],
    ['forward'],
    ['reload'],
    ['print'],
    ['viewSource'],
  ]);
});

test('cut needs a selection; paste without clipboard access uses the engine clipboard', async () => {
  const view = fakeView({ url: 'about:blank' });
  const items = defaultMenuItems(view, info({ editable: true }), {
    openTab() {},
    readText: async () => null,
  });
  const cut = items.find((item) => item.id === 'cut');
  assert.equal(cut.enabled, false);
  await items.find((item) => item.id === 'paste').action();
  assert.deepEqual(view.calls, [['command', 'Paste']]);
  assert.equal(items.find((item) => item.id === 'view-source').enabled, false, 'only for http(s)');
});

test('app actions replace reload, print and view source; texts are replaceable', () => {
  const view = fakeView();
  const used = [];
  const items = defaultMenuItems(
    view,
    info(),
    {
      openTab() {},
      reload: () => used.push('reload'),
      print: () => used.push('print'),
      viewSource: () => used.push('source'),
    },
    { texts: { reload: 'Neu laden' } },
  );
  for (const id of ['reload', 'print', 'view-source'])
    items.find((item) => item.id === id).action();
  assert.deepEqual(used, ['reload', 'print', 'source']);
  assert.deepEqual(view.calls, []);
  assert.equal(items.find((item) => item.id === 'reload').label, 'Neu laden');
});
