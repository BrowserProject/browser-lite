import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findByLetter,
  isHeader,
  isSeparator,
  moveInMenu,
  normalizeMenu,
} from '../dist/context-menu.js';
import { defaultMenuItems } from '../dist/index.js';
import { fakeView } from './fake-view.mjs';

const info = (extra = {}) => ({
  x: 10,
  y: 20,
  link: '',
  image: '',
  media: null,
  selection: '',
  editable: false,
  canUndo: false,
  canRedo: false,
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

test('moveInMenu wraps around like Chrome and starts from either end', () => {
  assert.equal(moveInMenu('ArrowDown', -1, 3), 0);
  assert.equal(moveInMenu('ArrowDown', 1, 3), 2);
  assert.equal(moveInMenu('ArrowDown', 2, 3), 0);
  assert.equal(moveInMenu('ArrowUp', -1, 3), 2);
  assert.equal(moveInMenu('ArrowUp', 0, 3), 2);
  assert.equal(moveInMenu('ArrowUp', 2, 3), 1);
  assert.equal(moveInMenu('Home', 2, 3), 0);
  assert.equal(moveInMenu('PageUp', 2, 3), 0);
  assert.equal(moveInMenu('End', -1, 3), 2);
  assert.equal(moveInMenu('PageDown', 0, 3), 2);
  assert.equal(moveInMenu('Enter', 0, 3), null);
  assert.equal(moveInMenu('ArrowDown', -1, 0), null);
});

test('findByLetter goes to the next match and tells when it is the only one', () => {
  const labels = ['Reload', 'Print…', ' reopen closed tab', 'View page source'];
  assert.deepEqual(findByLetter('r', labels, -1), { position: 0, only: false });
  assert.deepEqual(findByLetter('R', labels, 0), { position: 2, only: false });
  assert.deepEqual(findByLetter('r', labels, 2), { position: 0, only: false });
  assert.deepEqual(findByLetter('v', labels, 0), { position: 3, only: true });
  assert.equal(findByLetter('x', labels, -1), null);
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
      readClipboard: async () => ({ text: 'clip', html: '<b>clip</b>' }),
    },
  );
  assert.deepEqual(ids(normalizeMenu(items)), [
    'open-link',
    'save-link',
    'copy-link',
    '-',
    'open-image',
    'save-image',
    'copy-image',
    'copy-image-address',
    '-',
    'undo',
    'redo',
    '-',
    'cut',
    'copy',
    'paste',
    'paste-plain',
    'select-all',
  ]);
  const run = async (id) => items.find((item) => item.id === id).action();
  await run('open-link');
  await run('save-link');
  await run('copy-link');
  await run('open-image');
  await run('save-image');
  await run('copy-image');
  await run('copy-image-address');
  await run('cut');
  await run('copy');
  await run('undo');
  await run('redo');
  await run('paste');
  await run('paste-plain');
  await run('select-all');
  assert.deepEqual(opened, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(copied, ['https://l.test/', 'https://i.test/x.png']);
  assert.deepEqual(view.calls, [
    ['download', 'https://l.test/'],
    ['download', 'https://i.test/x.png'],
    ['copyImage', 10, 20],
    ['command', 'Cut'],
    ['command', 'Copy'],
    ['command', 'Undo'],
    ['command', 'Redo'],
    ['paste', { text: 'clip', html: '<b>clip</b>' }],
    ['paste', 'clip'],
    ['command', 'SelectAll'],
  ]);
});

const video = (extra = {}) => ({
  type: 'video',
  url: 'https://v.test/clip.webm',
  canSave: true,
  loop: false,
  canLoop: true,
  controls: true,
  canToggleControls: true,
  pictureInPicture: 'available',
  ...extra,
});

test('video: the media items of Chrome, checkable, before the page commands', async () => {
  const view = fakeView();
  const opened = [];
  const copied = [];
  const items = defaultMenuItems(view, info({ media: video() }), {
    openTab: (url) => opened.push(url),
    copyText: (text) => copied.push(text),
  });
  assert.deepEqual(ids(normalizeMenu(items)), [
    'loop',
    'show-controls',
    '-',
    'open-media',
    'save-media',
    'copy-media-address',
    'picture-in-picture',
    '-',
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
  assert.deepEqual(
    [
      'loop',
      'show-controls',
      'open-media',
      'save-media',
      'copy-media-address',
      'picture-in-picture',
    ].map((id) => [byId[id].label, byId[id].checked, byId[id].enabled]),
    [
      ['Loop', false, true],
      ['Show controls', true, true],
      ['Open video in new tab', undefined, true],
      ['Save video as…', undefined, true],
      ['Copy video address', undefined, true],
      ['Picture in picture', false, true],
    ],
  );
  for (const id of [
    'loop',
    'show-controls',
    'open-media',
    'save-media',
    'copy-media-address',
    'picture-in-picture',
  ])
    await byId[id].action();
  assert.deepEqual(opened, ['https://v.test/clip.webm']);
  assert.deepEqual(copied, ['https://v.test/clip.webm']);
  assert.deepEqual(view.calls, [
    ['mediaAction', 10, 20, 'loop', true],
    ['mediaAction', 10, 20, 'controls', false],
    ['download', 'https://v.test/clip.webm'],
    ['mediaAction', 10, 20, 'picture-in-picture', true],
  ]);
});

test('video in the window, from MediaSource, without picture-in-picture, audio', () => {
  const find = (media, id) =>
    defaultMenuItems(fakeView(), info({ media }), { openTab() {} }).find((item) => item.id === id);
  const active = find(video({ pictureInPicture: 'active', loop: true }), 'picture-in-picture');
  assert.equal(active.checked, true);
  const view = fakeView();
  defaultMenuItems(view, info({ media: video({ pictureInPicture: 'active' }) }), { openTab() {} })
    .find((item) => item.id === 'picture-in-picture')
    .action();
  assert.deepEqual(view.calls, [['mediaAction', 10, 20, 'picture-in-picture', false]]);
  assert.equal(
    find(video({ pictureInPicture: 'unavailable' }), 'picture-in-picture').enabled,
    false,
  );
  assert.equal(find(video({ pictureInPicture: 'unsupported' }), 'picture-in-picture'), undefined);
  const mse = video({ url: 'blob:https://v.test/1', canSave: false });
  assert.equal(find(mse, 'open-media').enabled, false);
  assert.equal(find(mse, 'save-media').enabled, false);
  assert.equal(find(mse, 'copy-media-address').enabled, true);
  const stream = video({ url: '', canSave: false, canLoop: false });
  assert.equal(find(stream, 'copy-media-address').enabled, false);
  assert.equal(find(stream, 'loop').enabled, false);
  const audio = video({ type: 'audio', canToggleControls: false, pictureInPicture: 'unsupported' });
  assert.deepEqual(
    ['open-media', 'save-media', 'copy-media-address'].map((id) => find(audio, id).label),
    ['Open audio in new tab', 'Save audio as…', 'Copy audio address'],
  );
  assert.equal(find(audio, 'show-controls').enabled, false);
});

test('long press on a video: its address as header, its items, no page commands', () => {
  const items = defaultMenuItems(fakeView(), info({ media: video(), touch: true }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(items)), [
    '# https://v.test/clip.webm',
    'loop',
    'show-controls',
    '-',
    'open-media',
    'save-media',
    'copy-media-address',
    'picture-in-picture',
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

test('field with a caret: undo, redo, cut and copy follow the state, no page commands', async () => {
  const view = fakeView();
  const items = defaultMenuItems(view, info({ editable: true, canGoBack: true, canUndo: true }), {
    openTab() {},
    search: { engine: 'Bing', open() {} },
    readClipboard: async () => null,
  });
  assert.deepEqual(ids(normalizeMenu(items)), [
    'undo',
    'redo',
    '-',
    'cut',
    'copy',
    'paste',
    'paste-plain',
    'select-all',
  ]);
  const byId = (id) => items.find((item) => item.id === id);
  assert.equal(byId('undo').enabled, true);
  assert.equal(byId('redo').enabled, false);
  assert.equal(byId('cut').enabled, false);
  assert.equal(byId('copy').enabled, false);
  assert.equal(byId('paste').enabled, undefined);
  assert.deepEqual(
    items.filter((item) => item.label).map((item) => item.label),
    ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'],
  );
  await byId('paste').action();
  await byId('paste-plain').action();
  assert.deepEqual(
    view.calls,
    [
      ['command', 'Paste'],
      ['command', 'PasteAndMatchStyle'],
    ],
    'no clipboard access: engine clipboard',
  );
});

test('search for the selection like Chrome, on the page and in fields', async () => {
  const searched = [];
  const search = { engine: 'Bing', open: (text) => searched.push(text) };
  const page = defaultMenuItems(fakeView(), info({ selection: ' Private\n' }), {
    openTab() {},
    search,
  });
  assert.deepEqual(ids(normalizeMenu(page)).slice(0, 3), ['copy', 'search', 'select-all']);
  const item = page.find((entry) => entry.id === 'search');
  assert.equal(item.label, 'Search Bing for “Private”');
  await item.action();
  const field = defaultMenuItems(fakeView(), info({ selection: 'abc', editable: true }), {
    openTab() {},
    search,
  });
  assert.deepEqual(ids(normalizeMenu(field)).slice(-3), ['select-all', '-', 'search']);
  const touch = defaultMenuItems(fakeView(), info({ selection: 'word', touch: true }), {
    openTab() {},
    search,
  });
  assert.deepEqual(ids(normalizeMenu(touch)), ['copy', 'search', 'select-all']);
  assert.deepEqual(searched, ['Private']);
  // Long selections: the label shortens at a word break, the search takes all of it
  const long = 'The quick brown fox jumps over the lazy dog and keeps on running far away';
  const longItem = defaultMenuItems(fakeView(), info({ selection: `${long}\n\n` }), {
    openTab() {},
    search,
    copyText() {},
  }).find((entry) => entry.id === 'search');
  assert.equal(
    longItem.label,
    'Search Bing for “The quick brown fox jumps over the lazy dog and…”',
  );
  await longItem.action();
  assert.equal(searched.at(-1), long);
  // No search without an engine or for white space only
  for (const [selection, actions] of [
    ['Private', { openTab() {} }],
    [' \n ', { openTab() {}, search }],
  ])
    assert.equal(
      defaultMenuItems(fakeView(), info({ selection }), actions).some((e) => e.id === 'search'),
      false,
    );
  const texts = { searchFor: 'Mit {engine} nach „{text}“ suchen' };
  const german = defaultMenuItems(
    fakeView(),
    info({ selection: 'x' }),
    { openTab() {}, search },
    {
      texts,
    },
  );
  assert.equal(german.find((entry) => entry.id === 'search').label, 'Mit Bing nach „x“ suchen');
});

test('view source only for http(s) pages', () => {
  const items = defaultMenuItems(fakeView({ url: 'about:blank' }), info(), { openTab() {} });
  assert.equal(items.find((item) => item.id === 'view-source').enabled, false);
});

test('app actions replace download, reload, print and view source; texts are replaceable', () => {
  const view = fakeView();
  const used = [];
  const items = defaultMenuItems(
    view,
    info({ image: 'https://i.test/x.png' }),
    {
      openTab() {},
      download: (url) => used.push(`download ${url}`),
      reload: () => used.push('reload'),
      print: () => used.push('print'),
      viewSource: () => used.push('source'),
    },
    { texts: { reload: 'Neu laden' } },
  );
  for (const id of ['save-image', 'reload', 'print', 'view-source'])
    items.find((item) => item.id === id).action();
  assert.deepEqual(used, ['download https://i.test/x.png', 'reload', 'print', 'source']);
  assert.deepEqual(view.calls, []);
  assert.equal(items.find((item) => item.id === 'reload').label, 'Neu laden');
});

test('long press on a link: its address as header and only its commands', () => {
  const items = defaultMenuItems(
    fakeView(),
    info({ touch: true, link: 'https://l.test/a', canGoBack: true }),
    { openTab() {} },
  );
  assert.deepEqual(ids(normalizeMenu(items)), [
    '# https://l.test/a',
    'open-link',
    'save-link',
    'copy-link',
  ]);
});

test('long press on an image: its address as header; on a linked image the link', () => {
  const image = defaultMenuItems(fakeView(), info({ touch: true, image: 'https://i.test/x.png' }), {
    openTab() {},
  });
  assert.deepEqual(ids(normalizeMenu(image)), [
    '# https://i.test/x.png',
    'open-image',
    'save-image',
    'copy-image',
    'copy-image-address',
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
