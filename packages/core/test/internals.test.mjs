// Parts of the core that need no browser: page dialogs, permission and HTTP authentication
// answers (Requests), the
// downloads, the upload limit, popups without a new-view listener, typed addresses and their
// fallback to http://, the pending navigation, the engine check and the edits of the IME field.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpFallback, httpFallback, typedAddress } from '../dist/address.js';
import { Downloads } from '../dist/downloads.js';
import { checkEngine, ENGINE_ABI_VERSION } from '../dist/engine.js';
import { requestHandler } from '../dist/handlers.js';
import { textEdit } from '../dist/keyboard.js';
import { PendingNavigation } from '../dist/pending.js';
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
    _bl_auth_answer: record('auth'),
    _bl_download_cancel: record('cancel'),
    _bl_remove_path: record('remove'),
    _bl_datalist_choose: record('datalist'),
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
    loadFromPage(url) {
      this.loaded.push(url);
    },
    pendingEnded: 0,
    endPending() {
      this.pendingEnded++;
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
  const watchdog = { closed: 0, dialogClosed: () => watchdog.closed++ };
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
  for (let type = 0; type <= 5; type++) requests.dialog(type + 1, view, type, 'o', 'm', 'd');
  assert.deepEqual(module.calls, [
    ['dialog', 1, 0, 0],
    ['dialog', 2, 0, 0],
    ['dialog', 3, 0, 0],
    ['dialog', 4, 1, 0],
    ['dialog', 5, 1, 0],
    ['dialog', 6, 0, 0],
  ]);
});

test('dialogs: staying on beforeunload ends the pending navigation, leaving does not', () => {
  const answers = [false, true, false];
  const { requests } = requestsWith({ dialog: () => answers.shift() });
  const view = fakeView();
  requests.dialog(1, view, 3, 'o', '', '');
  assert.equal(view.pendingEnded, 1);
  requests.dialog(2, view, 3, 'o', '', '');
  requests.dialog(3, view, 1, 'o', 'm', '');
  assert.equal(view.pendingEnded, 1);
});

test('typed addresses: https:// with an http:// fallback, local ones http:// like Chrome', () => {
  assert.equal(typedAddress('https://a.example'), 'https://a.example/');
  assert.equal(typedAddress('http://a.example/x'), 'http://a.example/x');
  assert.equal(typedAddress('a.example/x?y'), 'https://a.example/x?y');
  assert.equal(typedAddress(' a.example '), 'https://a.example/');
  assert.equal(typedAddress('about:blank'), 'about:blank');
  // Port 80 is http's own: upgraded like the address without it
  assert.equal(typedAddress('neverssl.example:80'), 'https://neverssl.example/');
  for (const [text, url] of [
    ['localhost:8080/links', 'http://localhost:8080/links'],
    ['localhost', 'http://localhost/'],
    ['app.localhost', 'http://app.localhost/'],
    ['127.0.0.1:7650/links', 'http://127.0.0.1:7650/links'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['intranet/wiki', 'http://intranet/wiki'],
    ['portquiz.example:8080', 'http://portquiz.example:8080/'],
    ['a.example:443', 'http://a.example:443/'],
  ]) {
    assert.equal(typedAddress(text), url, text);
    assert.equal(httpFallback(text), '', text);
  }
  assert.equal(httpFallback('httpforever.example'), 'http://httpforever.example/');
  assert.equal(httpFallback('a.example/x?y'), 'http://a.example/x?y');
  // Typed with a scheme: that scheme, no fallback
  for (const text of ['https://a.example/', 'http://a.example/', 'about:blank', 'a b'])
    assert.equal(httpFallback(text), '', text);
  // Invalid with a scheme: no https:// in front, which would make the scheme the host
  for (const text of [
    'mailto:a@b.example',
    'javascript:alert(1)',
    'zoommtg://x',
    'a b',
    '',
    'http://example.com:99999/',
    'example.com:99999',
    'https://a b.example/',
  ])
    assert.equal(typedAddress(text), '', text);
});

test('typed addresses: http:// after the error page of a failed connection or TLS', () => {
  const fallback = new HttpFallback();
  // No connection: error, network error page, its load
  fallback.start('http://a.example/');
  fallback.error();
  fallback.commit('network');
  assert.equal(fallback.load(), 'http://a.example/');
  assert.equal(fallback.load(), '');
  fallback.start('http://a.example/');
  fallback.error();
  fallback.commit('certificate');
  assert.equal(fallback.load(), 'http://a.example/');
  // An HTTP error is the answer of the https:// site
  fallback.start('http://a.example/');
  fallback.error();
  fallback.commit('http');
  assert.equal(fallback.load(), '');
  // The https:// page loads, or another navigation of the host replaces the typed one
  fallback.start('http://a.example/');
  fallback.commit(null);
  fallback.error();
  fallback.commit('network');
  assert.equal(fallback.load(), '');
  fallback.start('http://a.example/');
  fallback.start('');
  fallback.error();
  fallback.commit('network');
  assert.equal(fallback.load(), '');
});

test('pending navigation: the address the engine loads, until it arrives or loading ends', () => {
  const pending = new PendingNavigation();
  pending.start('https://b.example/slow');
  // The engine reports the start with the address of the document being left
  pending.update('https://a.example/', true);
  assert.equal(pending.url, 'https://b.example/slow');
  pending.update('https://b.example/slow', true);
  assert.equal(pending.url, '');
  // Stopped, failed or a download: loading ends with the old document
  pending.start('https://b.example/file.zip');
  pending.update('https://a.example/', false);
  assert.equal(pending.url, '');
  // A document committed, the page stayed or another app took the address
  pending.start('https://b.example/');
  assert.equal(pending.end(), true);
  assert.equal(pending.end(), false);
});

test('dialogs: resubmit sends the form again only on true, the engine may withdraw it', async () => {
  const seen = [];
  const answers = [true, 'yes', undefined];
  const { requests, module, watchdog } = requestsWith({
    dialog(request) {
      seen.push(request);
      if (!answers.length) return new Promise(() => {});
      return answers.shift();
    },
  });
  const view = fakeView();
  for (let id = 1; id <= 4; id++) requests.dialog(id, view, 5, 'https://a.example', '', '');
  assert.deepEqual(
    seen.map((request) => request.type),
    ['resubmit', 'resubmit', 'resubmit', 'resubmit'],
  );
  assert.equal(seen[0].reload, false);
  assert.equal(requests.hasDialog(view), true);
  // The page navigated meanwhile ('dialog-cancel'): aborted, no answer to the engine
  requests.cancelDialog(4);
  requests.cancelDialog(4);
  assert.equal(seen[3].signal.aborted, true);
  assert.equal(requests.hasDialog(view), false);
  assert.equal(watchdog.closed, 4);
  assert.deepEqual(module.calls, [
    ['dialog', 1, 1, 0],
    ['dialog', 2, 0, 0],
    ['dialog', 3, 0, 0],
  ]);
});

test('dialogs: direct and promised answers, the watchdog restarts after each', async () => {
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
  assert.equal(watchdog.closed, 2);
  assert.equal(requests.hasDialog(view), true);
  assert.equal(requests_[2].reload, false);
  assert.ok(requests_[2].signal instanceof AbortSignal);
  resolveLater(true);
  await tick();
  assert.equal(watchdog.closed, 3);
  assert.equal(requests.hasDialog(view), false);
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

test('datalist: the chosen value goes to the engine, a superseded or hidden list answers nothing', async () => {
  const pending = [];
  const { requests, module } = requestsWith({
    dataListPopup: (request) =>
      new Promise((resolve) => {
        pending.push({ request, resolve });
        request.signal.addEventListener('abort', () => resolve(-1));
      }),
  });
  const view = fakeView();
  const suggestions = [{ value: 'Zurich' }, { value: 'Zug', label: 'Canton Zug' }];
  const first = requests.dataListPopup(view, { x: 1, y: 2, width: 3, height: 4, suggestions });
  const second = requests.dataListPopup(view, { suggestions, highlightedIndex: 1 });
  await first;
  assert.equal(pending[0].request.signal.aborted, true);
  assert.deepEqual(pending[0].request.rect, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(pending[1].request.suggestions, [
    { value: 'Zurich', label: '' },
    { value: 'Zug', label: 'Canton Zug' },
  ]);
  assert.equal(pending[1].request.highlightedIndex, 1);
  pending[1].resolve(1);
  await second;
  const third = requests.dataListPopup(view, { suggestions });
  pending[2].resolve(-1);
  await third;
  const fourth = requests.dataListPopup(view, { suggestions });
  requests.hidePicker(view, 'datalist');
  await fourth;
  // Without a handler the list closes at once
  const bare = requestsWith({});
  await bare.requests.dataListPopup(view, { suggestions });
  assert.deepEqual(module.calls, [
    ['datalist', 1, 'Zug'],
    ['datalist', 1, 0],
  ]);
  assert.deepEqual(bare.module.calls, [['datalist', 1, 0]]);
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
  assert.equal(watchdog.closed, 1);
  assert.deepEqual(module.calls, [['dialog', 7, 1, 0]]);
  // closeDialogs answers the dialogs of one view (it navigates) or all (destroy)
  const other = requestsWith({ dialog: () => new Promise(() => {}) });
  const first = fakeView(2);
  other.requests.dialog(8, first, 1, 'o', 'm', '');
  other.requests.dialog(9, fakeView(3), 2, 'o', 'm', 'd');
  other.requests.closeDialogs(first);
  assert.deepEqual(other.module.calls, [['dialog', 8, 0, 0]]);
  other.requests.closeDialogs();
  assert.deepEqual(other.module.calls, [
    ['dialog', 8, 0, 0],
    ['dialog', 9, 0, 0],
  ]);
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

test('authentication: credentials, cancel, defaults, auth-cancel and closed views', async () => {
  const none = requestsWith({});
  await none.requests.authenticate(fakeView(), { id: 1, realm: 'r' });
  assert.deepEqual(none.module.calls, [['auth', 1, 0, 0]]);

  const seen = [];
  const answers = [{ username: 'ann', password: 'pw' }, null, { username: 1 }];
  const { requests, module } = requestsWith({
    async authenticate(request) {
      seen.push([request.url, request.origin, request.realm, request.scheme, request.retry]);
      if (request.realm === 'wait')
        return new Promise((resolve) =>
          request.signal.addEventListener('abort', () => resolve({ username: 'x', password: 'y' })),
        );
      if (request.realm === 'throw') throw new Error('no');
      return answers.shift();
    },
  });
  const view = fakeView();
  const data = {
    url: 'https://a.example/p',
    origin: 'https://a.example',
    realm: 'Area',
    scheme: 'digest',
  };
  await requests.authenticate(view, { id: 2, ...data, retry: true });
  await requests.authenticate(view, { id: 3, ...data });
  await requests.authenticate(view, { id: 4, ...data, scheme: 'other' });
  await requests.authenticate(view, { id: 5, realm: 'throw' });
  const cancelled = requests.authenticate(view, { id: 6, realm: 'wait' });
  requests.cancelAuth(6);
  await cancelled;
  const closed = requests.authenticate(view, { id: 7, realm: 'wait' });
  requests.closeView(view);
  await closed;
  assert.deepEqual(seen[0], ['https://a.example/p', 'https://a.example', 'Area', 'digest', true]);
  assert.deepEqual(seen[2].slice(3), ['basic', false]);
  assert.deepEqual(module.calls, [
    ['auth', 2, 'ann', 'pw'],
    ['auth', 3, 0, 0],
    ['auth', 4, 0, 0],
    ['auth', 5, 0, 0],
    ['auth', 7, 0, 0],
  ]);
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

test('IME field edits: Backspaces per grapheme cluster, then the new text', () => {
  assert.deepEqual(textEdit('', 'x'), { backspaces: 0, insert: 'x' });
  assert.deepEqual(textEdit('xy', 'x'), { backspaces: 1, insert: '' });
  assert.deepEqual(textEdit('xy', ''), { backspaces: 2, insert: '' });
  // A suggestion replaces the word
  assert.deepEqual(textEdit('a helo', 'a hello '), { backspaces: 1, insert: 'lo ' });
  // An emoji sequence and a vowel sign go with one Backspace like in the engine
  assert.deepEqual(textEdit('a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 'a'), {
    backspaces: 1,
    insert: '',
  });
  assert.deepEqual(textEdit('\u0915\u093F', '\u0915'), { backspaces: 1, insert: '\u0915' });
  assert.deepEqual(textEdit('same', 'same'), { backspaces: 0, insert: '' });
});
