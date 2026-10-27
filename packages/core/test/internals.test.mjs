// Parts of the core that need no browser: page dialogs and permission answers (Requests), the
// downloads, the upload limit, popups without a new-view listener and the engine check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Downloads } from '../dist/downloads.js';
import { checkEngine, ENGINE_ABI_VERSION } from '../dist/engine.js';
import { requestHandler } from '../dist/handlers.js';
import { MemoryPermissionStore } from '../dist/permissions.js';
import { redirectPopup } from '../dist/popups.js';
import { Requests } from '../dist/requests.js';
import { MAX_UPLOAD, Uploads } from '../dist/uploads.js';
import { errorText } from '../dist/util.js';

/** Engine module that records the calls of the exports the tests need. */
function fakeModule() {
  const calls = [];
  const strings = new Map();
  let next = 1;
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args.map((arg) => (strings.has(arg) ? strings.get(arg) : arg))]);
  return {
    calls,
    stringToNewUTF8(text) {
      const pointer = 1000 + next++;
      strings.set(pointer, text);
      return pointer;
    },
    _bl_dialog_answer: record('dialog'),
    _bl_permission_answer: record('permission'),
    _bl_download_cancel: record('cancel'),
    _bl_remove_path: record('remove'),
  };
}

function fakeView(id = 1) {
  const listeners = new Map();
  return {
    id,
    closed: false,
    get alive() {
      return !this.closed;
    },
    loaded: [],
    emitted: [],
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return () =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l !== listener),
        );
    },
    emit(type, event) {
      this.emitted.push([type, event]);
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    load(url) {
      this.loaded.push(url);
    },
    async close() {
      this.closed = true;
      this.emit('close', {});
      return true;
    },
  };
}

function requestsWith(handlers, store = new MemoryPermissionStore(), chain = {}) {
  const module = fakeModule();
  const watchdog = { paused: 0, pause: () => watchdog.paused++, resume: () => watchdog.paused-- };
  const host = {
    module,
    watchdog,
    ready: true,
    config: { handlers, permissions: store },
    text: (value) => module.stringToNewUTF8(value ?? ''),
    uploads: { write: async () => [] },
    handler: (type) => requestHandler(type, handlers[type], chain[type] ?? []),
  };
  return { requests: new Requests(host), module, watchdog, host };
}

const tick = () => new Promise((resolve) => setTimeout(resolve));

test('dialogs: defaults without a handler', () => {
  const { requests, module } = requestsWith({});
  const view = fakeView();
  for (let type = 0; type <= 4; type++) requests.dialog(type + 1, view, type, 'o', 'm', 'd');
  assert.deepEqual(module.calls, [
    ['dialog', 1, 0, 0],
    ['dialog', 2, 0, 0],
    ['dialog', 3, 0, 0],
    ['dialog', 4, 1, 0],
    ['dialog', 5, 1, 0],
  ]);
});

test('dialogs: direct and promised answers, watchdog paused meanwhile', async () => {
  let resolveLater;
  const requests_ = [];
  const { requests, module, watchdog } = requestsWith({
    dialog(request) {
      requests_.push(request);
      if (request.type === 'prompt') return request.defaultValue.toUpperCase();
      if (request.type === 'confirm')
        return new Promise((resolve) => {
          resolveLater = resolve;
        });
      return request.type === 'beforeunload' ? false : undefined;
    },
  });
  const view = fakeView();
  requests.dialog(1, view, 2, 'https://a.example', 'Name?', 'anna');
  requests.dialog(2, view, 3, 'https://a.example', '', '');
  requests.dialog(3, view, 1, 'https://a.example', 'Sure?', '');
  assert.equal(watchdog.paused, 1);
  assert.equal(requests_[2].reload, false);
  assert.ok(requests_[2].signal instanceof AbortSignal);
  resolveLater(true);
  await tick();
  assert.equal(watchdog.paused, 0);
  assert.deepEqual(module.calls, [
    ['dialog', 1, 1, 'ANNA'],
    ['dialog', 2, 0, 0],
    ['dialog', 3, 1, 0],
  ]);
});

test('dialogs and selects: handlers of extensions run before the own handler', async () => {
  const { requests, module } = requestsWith({ dialog: () => 'own' }, undefined, {
    dialog: [(request, next) => (request.type === 'confirm' ? true : next())],
    selectPopup: [async () => 1],
  });
  const view = fakeView();
  requests.dialog(1, view, 1, 'https://a.example', 'Sure?', '');
  requests.dialog(2, view, 2, 'https://a.example', 'Name?', '');
  // No own select handler: the extension answers anyway
  module._bl_popup_choose = (id, index) => module.calls.push(['popup', id, index]);
  await requests.selectPopup(view, { items: [{ text: 'a' }, { text: 'b' }] });
  assert.deepEqual(module.calls, [
    ['dialog', 1, 1, 0],
    ['dialog', 2, 1, 'own'],
    ['popup', 1, 1],
  ]);
});

test('dialogs: closing the view answers with the default and aborts the request', async () => {
  let signal;
  const { requests, module, watchdog } = requestsWith({
    dialog(request) {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  const view = fakeView();
  requests.dialog(7, view, 3, 'o', '', '');
  view.closed = true;
  requests.closeView(view);
  assert.equal(signal.aborted, true);
  assert.equal(watchdog.paused, 0);
  assert.deepEqual(module.calls, [['dialog', 7, 1, 0]]);
  // closeDialogs (destroy) answers what is still open
  const other = requestsWith({ dialog: () => new Promise(() => {}) });
  other.requests.dialog(8, fakeView(2), 1, 'o', 'm', '');
  other.requests.closeDialogs();
  assert.deepEqual(other.module.calls, [['dialog', 8, 0, 0]]);
});

test('permissions: grant and deny are remembered, dismiss and errors are not', async () => {
  const answers = ['grant', 'dismiss', 'deny'];
  const store = new MemoryPermissionStore();
  const { requests, module } = requestsWith(
    {
      async permission({ kind }) {
        const answer = answers.shift();
        if (kind === 'notifications') throw new Error('no');
        return answer;
      },
    },
    store,
  );
  const view = fakeView();
  await requests.permission(view, { id: 1, kind: 'geolocation', origin: 'https://a.example' });
  await requests.permission(view, { id: 2, kind: 'camera', origin: 'https://a.example' });
  await requests.permission(view, {
    id: 3,
    kind: 'camera-microphone',
    origin: 'https://b.example',
  });
  await requests.permission(view, { id: 4, kind: 'notifications', origin: 'https://a.example' });
  assert.deepEqual(module.calls, [
    ['permission', 1, 1],
    ['permission', 2, 0],
    ['permission', 3, 2],
    ['permission', 4, 0],
  ]);
  assert.deepEqual(
    [...store.entries()],
    [
      ['https://a.example', 'geolocation', 'grant'],
      ['https://b.example', 'camera', 'deny'],
      ['https://b.example', 'microphone', 'deny'],
    ],
  );
});

test('downloads: events with the download, cancel, abort and auto save', () => {
  const module = fakeModule();
  const announced = [];
  let listening = true;
  const downloads = new Downloads({
    module,
    ready: true,
    announceDownload(download) {
      announced.push(download);
      return listening;
    },
  });
  const view = fakeView(3);
  downloads.start(
    { id: 1, filename: 'a.txt', mime: 'text/plain', url: 'https://a/a.txt', size: 4 },
    view,
  );
  const [first] = announced;
  assert.equal(first.view, view);
  const events = [];
  for (const type of ['progress', 'done', 'error'])
    first.on(type, (event) => events.push([type, event.download === first, first.state]));
  downloads.data(1, new Uint8Array([1, 2]));
  first.cancel();
  downloads.data(1, new Uint8Array([3, 4]));
  downloads.done({ id: 1, error: 'Cancelled' });
  assert.deepEqual(events, [
    ['progress', true, 'progress'],
    ['error', true, 'error'],
  ]);
  assert.equal(first.error, 'Cancelled');
  assert.deepEqual(module.calls, [['cancel', 1]]);

  downloads.start({ id: 2, filename: 'b', size: 0 }, undefined);
  const second = announced[1];
  assert.equal(second.view, null);
  downloads.abortAll();
  assert.equal(second.state, 'error');
  assert.equal(second.error, 'Aborted');
  second.cancel();
  assert.deepEqual(module.calls, [['cancel', 1]]);

  // Nobody listens: saved when done
  listening = false;
  downloads.start({ id: 3, filename: 'c' }, view);
  let saved = false;
  announced[2].save = () => {
    saved = true;
  };
  downloads.data(3, new Uint8Array([5]));
  downloads.done({ id: 3, error: '' });
  assert.equal(announced[2].state, 'done');
  assert.equal(announced[2].size, 1);
  assert.equal(saved, true);
});

test('uploads: files over the limit and unreadable files are reported', async () => {
  const module = fakeModule();
  module.blWriteFiles = async (files) => files.map((file) => !file.path.endsWith('/bad.txt'));
  const uploads = new Uploads({ module, ready: true, text: (v) => module.stringToNewUTF8(v) });
  const view = fakeView(5);
  const big = { name: 'big.iso', size: MAX_UPLOAD + 1 };
  const paths = await uploads.write(view, [
    new File(['x'], 'ok.txt'),
    big,
    new File(['y'], 'bad.txt'),
  ]);
  assert.deepEqual(paths, ['/data/tmp/uploads/5/1/ok.txt']);
  assert.deepEqual(view.emitted, [
    [
      'files-skipped',
      {
        files: [
          { name: 'big.iso', reason: 'too-large' },
          { name: 'bad.txt', reason: 'unreadable' },
        ],
      },
    ],
  ]);
});

test('popup without a new-view listener: its address loads in the opener', async () => {
  const opener = fakeView(1);
  const popup = fakeView(1 << 20);
  redirectPopup(popup, opener);
  popup.emit('navigation', { url: 'about:blank' });
  assert.equal(popup.closed, false);
  popup.emit('navigation', { url: 'https://b.example/' });
  await tick();
  assert.equal(popup.closed, true);
  assert.deepEqual(opener.loaded, ['https://b.example/']);
  // Without an opener it only closes
  const lonely = fakeView(2);
  redirectPopup(lonely, null);
  lonely.emit('navigation', { url: 'https://c.example/' });
  assert.equal(lonely.closed, true);
});

test('engine check: ABI version and exports', () => {
  const exports = {};
  const module = new Proxy(exports, {
    get: (target, name) => (name in target ? target[name] : () => 0),
  });
  exports.blAbiVersion = ENGINE_ABI_VERSION;
  checkEngine(module);
  exports.blAbiVersion = ENGINE_ABI_VERSION - 1;
  assert.throws(
    () => checkEngine(module),
    (error) => error.code === 'engine-load-failed' && /ABI version/.test(error.message),
  );
  assert.throws(
    () => checkEngine({ blAbiVersion: ENGINE_ABI_VERSION }),
    (error) => error.code === 'engine-load-failed' && /lacks _bl_create_view/.test(error.message),
  );
});

test('crash reason: name and message before the stack, also where the stack lacks them', () => {
  const v8 = new Error('Aborted(OOM)');
  v8.stack = 'Error: Aborted(OOM)\n    at f (engine.wasm:1:2)';
  assert.equal(errorText(v8), v8.stack);
  const firefox = Object.assign(new Error('unreachable'), { name: 'RuntimeError' });
  firefox.stack = 'f@engine.wasm:1:2\n';
  assert.equal(errorText(firefox), 'RuntimeError: unreachable\nf@engine.wasm:1:2\n');
  const bare = new Error('gone');
  bare.stack = undefined;
  assert.equal(errorText(bare), 'Error: gone');
});
