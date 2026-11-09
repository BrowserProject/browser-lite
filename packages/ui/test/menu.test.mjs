import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHeader, isSeparator, normalizeMenu } from '../dist/context-menu.js';
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
  touch: false,
  ...extra,
});
const ids = (items) =>
  items.map((item) => (isSeparator(item) ? '-' : isHeader(item) ? `# ${item.header}` : item.id));

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
    'cut',
    'copy',
    'paste',
    'select-all',
  ]);
  const run = async (id) => items.find((item) => item.id === id).action();
  await run('open-link');
  await run('copy-link');
  await run('open-image');
  await run('copy-image');
  await run('cut');
  await run('copy');
  await run('paste');
  await run('select-all');
  assert.deepEqual(opened, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(copied, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(view.calls, [
    ['command', 'Cut'],
    ['command', 'Copy'],
    ['paste', 'clip'],
    ['command', 'SelectAll'],
  ]);
});

test('selection on the page: copy, select all and the page commands', async () => {
  const view = fakeView();
  const items = defaultMenuItems(view, info({ selection: 'sel', canGoForward: true }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(items)), [
    'copy',
    'select-all',
    '-',
    'back',
    'forward',
    'reload',
    'print',
    'view-source',
  ]);
  for (const id of ['copy', 'back', 'forward', 'reload', 'print', 'view-source'])
    await items.find((item) => item.id === id).action();
  assert.deepEqual(view.calls, [
    ['command', 'Copy'],
    ['back'],
    ['forward'],
    ['reload'],
    ['print'],
    ['viewSource'],
  ]);
});

test('field with a caret: cut and copy disabled, no page commands', async () => {
  const view = fakeView();
  const items = defaultMenuItems(view, info({ editable: true, canGoBack: true }), {
    openTab() {},
    readText: async () => null,
  });
  assert.deepEqual(ids(normalizeMenu(items)), ['cut', 'copy', 'paste', 'select-all']);
  assert.equal(items.find((item) => item.id === 'cut').enabled, false);
  assert.equal(items.find((item) => item.id === 'copy').enabled, false);
  assert.equal(items.find((item) => item.id === 'paste').enabled, undefined);
  await items.find((item) => item.id === 'paste').action();
  assert.deepEqual(view.calls, [['command', 'Paste']], 'no clipboard access: engine clipboard');
});

test('view source only for http(s) pages', () => {
  const items = defaultMenuItems(fakeView({ url: 'about:blank' }), info(), { openTab() {} });
  assert.equal(items.find((item) => item.id === 'view-source').enabled, false);
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

test('long press on a link: its address as header and only its commands', () => {
  const items = defaultMenuItems(
    fakeView(),
    info({ touch: true, link: 'https://l.test/a', canGoBack: true }),
    { openTab() {} },
  );
  assert.deepEqual(ids(normalizeMenu(items)), ['# https://l.test/a', 'open-link', 'copy-link']);
});

test('long press on an image: its address as header; on a linked image the link', () => {
  const image = defaultMenuItems(fakeView(), info({ touch: true, image: 'https://i.test/x.png' }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(image)), [
    '# https://i.test/x.png',
    'open-image',
    'copy-image',
  ]);
  const linked = defaultMenuItems(
    fakeView(),
    info({ touch: true, link: 'https://l.test/', image: 'https://i.test/x.png' }),
    { openTab() {} },
  );
  assert.equal(normalizeMenu(linked)[0].header, 'https://l.test/');
});

test('long press on text: copy and select all; on plain page and in fields', () => {
  const word = defaultMenuItems(fakeView(), info({ touch: true, selection: 'in' }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(word)), ['copy', 'select-all']);
  const field = defaultMenuItems(fakeView(), info({ touch: true, editable: true }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(field)), ['cut', 'copy', 'paste', 'select-all']);
  assert.deepEqual(
    normalizeMenu(defaultMenuItems(fakeView(), info({ touch: true }), { openTab() {} })),
    [],
  );
});
