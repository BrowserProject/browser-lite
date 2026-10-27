// The extension host without an engine: registry, handler chain order, enable and disable,
// disposal, storage per extension, page content and messages, against a fake browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchPattern } from '../dist/extensions/content.js';
import { ATTACH } from '../dist/extensions/link.js';
import { requestHandler } from '../dist/handlers.js';
import { createExtensionHost } from '../dist/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve));

function fakeView(id) {
  const listeners = new Map();
  return {
    id,
    closed: false,
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return () => {};
    },
    close() {
      this.closed = true;
      for (const listener of listeners.get('close') ?? []) listener({});
    },
  };
}

/** A browser as the host sees it; records content and messages for the engine. */
function fakeBrowser(views = []) {
  const side = {
    browser: { name: 'browser' },
    content: [],
    posted: [],
    views: () => views,
    setContent: (json) => side.content.push(JSON.parse(json)),
    postMessage: (view, extension, json) =>
      side.posted.push([view.id, extension, JSON.parse(json)]),
  };
  return side;
}

const extension = (id, setup, version = '1.0.0') => ({ id, version, setup });

test('install checks the id and refuses a taken one', async () => {
  const host = createExtensionHost();
  await assert.rejects(host.install(extension('Bad Id', () => {})), { code: 'invalid-options' });
  await assert.rejects(host.install({ id: 'x' }), { code: 'invalid-options' });
  await host.install(extension('a', () => {}));
  await assert.rejects(host.install(extension('a', () => {})), { code: 'invalid-options' });
  assert.deepEqual(host.extensions, [{ id: 'a', version: '1.0.0', enabled: true, error: null }]);
});

test('install, disable, enable and uninstall report changes; setup runs per enable', async () => {
  const host = createExtensionHost({ app: { name: 'app' } });
  let changes = 0;
  host.on('change', () => changes++);
  const setups = [];
  await host.install(
    extension('a', (context) => {
      setups.push(context.app.name);
    }),
    { enabled: false },
  );
  assert.equal(host.extensions[0].enabled, false);
  assert.deepEqual(setups, []);
  await host.enable('a');
  await host.enable('a');
  assert.deepEqual(setups, ['app']);
  await host.disable('a');
  await host.enable('a');
  assert.deepEqual(setups, ['app', 'app']);
  await host.uninstall('a');
  assert.deepEqual(host.extensions, []);
  assert.equal(changes, 6);
  await assert.rejects(host.enable('a'), { code: 'invalid-options' });
});

test('a failing setup leaves the extension disabled and undoes its registrations', async () => {
  const host = createExtensionHost();
  const browser = fakeBrowser();
  const link = host[ATTACH](browser);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await host.install(
      extension('broken', async (context) => {
        context.handle('dialog', () => true);
        throw new Error('no');
      }),
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(host.extensions[0].enabled, false);
  assert.equal(host.extensions[0].error.message, 'no');
  assert.equal(link.handlers('dialog').length, 0);
});

test('handler chain: extensions in install order, then the own handler, then the default', async () => {
  const host = createExtensionHost();
  const link = host[ATTACH](fakeBrowser());
  const order = [];
  await host.install(
    extension('first', (context) => {
      context.handle('selectPopup', async (_request, next) => {
        order.push('first');
        return (await next()) + 1;
      });
    }),
  );
  let removeSecond;
  await host.install(
    extension('second', (context) => {
      removeSecond = context.handle('selectPopup', (request, next) => {
        order.push(`second:${request.items.length}`);
        return next();
      });
    }),
  );
  const own = async () => {
    order.push('own');
    return 4;
  };
  const request = { items: [1, 2] };
  const chained = requestHandler('selectPopup', own, link.handlers('selectPopup'));
  assert.equal(await chained(request), 5);
  assert.deepEqual(order, ['first', 'second:2', 'own']);
  // Without an own handler the default ends the chain (-1 for a select popup)
  assert.equal(
    await requestHandler('selectPopup', undefined, link.handlers('selectPopup'))(request),
    0,
  );
  removeSecond();
  assert.equal(link.handlers('selectPopup').length, 1);
  // Without extension handlers the own handler as it is, or none
  assert.equal(requestHandler('dialog', undefined, link.handlers('dialog')), undefined);
  assert.equal(requestHandler('selectPopup', own, []), own);
  await host.disable('first');
  assert.equal(link.handlers('selectPopup').length, 0);
});

test('an extension can answer a dialog without the rest of the chain', async () => {
  const host = createExtensionHost();
  const link = host[ATTACH](fakeBrowser());
  await host.install(
    extension('auto', (context) => {
      context.handle('dialog', (request, next) => (request.type === 'confirm' ? true : next()));
    }),
  );
  const own = () => 'own';
  const dialog = requestHandler('dialog', own, link.handlers('dialog'));
  assert.equal(dialog({ type: 'confirm' }), true);
  assert.equal(dialog({ type: 'prompt' }), 'own');
});

test('disable runs the returned disposers in reverse and the browser and view hooks', async () => {
  const host = createExtensionHost();
  const views = [fakeView(1)];
  const browser = fakeBrowser(views);
  const log = [];
  await host.install(
    extension('hooks', (context) => {
      context.onBrowser((b) => {
        log.push(`browser:${b.name}`);
        return () => log.push('browser-end');
      });
      context.onView((view) => {
        log.push(`view:${view.id}`);
        return [() => log.push(`view-end:${view.id}`)];
      });
      return [() => log.push('dispose-1'), () => log.push('dispose-2')];
    }),
  );
  assert.deepEqual(log, []);
  const link = host[ATTACH](browser);
  assert.deepEqual(log, ['browser:browser', 'view:1']);
  const second = fakeView(2);
  link.viewAdded(second);
  second.close();
  assert.deepEqual(log.slice(2), ['view:2', 'view-end:2']);
  log.length = 0;
  await host.disable('hooks');
  assert.deepEqual(log, ['view-end:1', 'browser-end', 'dispose-2', 'dispose-1']);
  // Nothing runs for a view of a disabled extension
  link.viewAdded(fakeView(3));
  assert.equal(log.length, 4);
});

test('detach ends the browser and view hooks; a new browser runs them again', async () => {
  const host = createExtensionHost();
  const log = [];
  await host.install(
    extension('restart', (context) => {
      context.onBrowser(() => () => log.push('browser-end'));
      context.onView((view) => () => log.push(`view-end:${view.id}`));
    }),
  );
  const first = host[ATTACH](fakeBrowser([fakeView(1)]));
  assert.throws(() => host[ATTACH](fakeBrowser()), { code: 'invalid-options' });
  first.detach();
  assert.deepEqual(log, ['view-end:1', 'browser-end']);
  const next = fakeBrowser();
  host[ATTACH](next);
  const extensionContext = [];
  await host.install(
    extension('later', (context) => {
      extensionContext.push(context.browser);
    }),
  );
  assert.deepEqual(extensionContext, [next.browser]);
});

test('storage: one record per extension, loaded before the setup, saved on change', async () => {
  const saved = [];
  const records = { a: { count: 1 } };
  const store = {
    load: async (id) => records[id] ?? null,
    save: (id, data) => saved.push([id, data]),
  };
  const host = createExtensionHost({ store });
  const contexts = {};
  for (const id of ['a', 'b'])
    await host.install(
      extension(id, (context) => {
        contexts[id] = context;
      }),
    );
  assert.equal(contexts.a.storage.get('count'), 1);
  assert.equal(contexts.b.storage.get('count'), undefined);
  contexts.b.storage.set('count', { n: 2 });
  contexts.a.storage.set('other', true);
  assert.deepEqual(contexts.b.storage.get('count'), { n: 2 });
  assert.deepEqual(contexts.a.storage.keys(), ['count', 'other']);
  contexts.a.storage.delete('count');
  assert.deepEqual(saved, [
    ['b', { count: { n: 2 } }],
    ['a', { count: 1, other: true }],
    ['a', { other: true }],
  ]);
  // A copy: changing the returned value changes nothing stored
  contexts.b.storage.get('count').n = 3;
  assert.deepEqual(contexts.b.storage.get('count'), { n: 2 });
});

test('page content: nothing goes to the engine without content, changes go once', async () => {
  const host = createExtensionHost();
  await host.install(extension('plain', () => {}));
  const browser = fakeBrowser();
  host[ATTACH](browser);
  await tick();
  assert.deepEqual(browser.content, []);
  let removeStyle;
  await host.install(
    extension('styled', (context) => {
      context.addScript({ matches: ['https://*.example.com/*'], code: 'run()' });
      removeStyle = context.addStyle({
        matches: ['<all_urls>'],
        excludeMatches: ['http://example.org/*'],
        code: 'p{}',
      });
    }),
  );
  await tick();
  assert.deepEqual(browser.content, [
    [
      {
        extension: 'styled',
        scripts: [
          {
            source: 'run()',
            matches: ['https://*.example.com/*'],
            excludes: [],
            runAt: 'document-end',
            allFrames: false,
            world: 'isolated',
          },
        ],
        styles: [
          {
            source: 'p{}',
            matches: ['*://*/*'],
            excludes: ['http://example.org/*'],
            allFrames: false,
          },
        ],
      },
    ],
  ]);
  removeStyle();
  await tick();
  assert.equal(browser.content.length, 2);
  assert.equal(browser.content[1][0].styles.length, 0);
  await host.disable('styled');
  await tick();
  assert.deepEqual(browser.content.at(-1), []);
});

test('match patterns and scripts are checked', () => {
  for (const ok of ['https://example.com/', '*://*/*', 'http://*.example.com/a*b', 'file:///x/*'])
    assert.equal(matchPattern(ok), ok);
  for (const bad of [
    'example.com',
    'https://exa*mple.com/',
    'https://example.com',
    'https://a:1/',
    3,
  ])
    assert.throws(() => matchPattern(bad), { code: 'invalid-options' });
  const host = createExtensionHost();
  return host.install(
    extension('checks', (context) => {
      assert.throws(() => context.addScript({ matches: [], code: '' }), {
        code: 'invalid-options',
      });
      assert.throws(() => context.addScript({ matches: ['*://*/*'], code: '', runAt: 'idle' }), {
        code: 'invalid-options',
      });
      assert.throws(() => context.addStyle({ matches: ['*://*/*'] }), { code: 'invalid-options' });
      assert.throws(() => context.handle('dialogs', () => {}), { code: 'invalid-options' });
      assert.throws(() => context.handle('dialog', 'no'), { code: 'invalid-options' });
    }),
  );
});

test('messages: to the extension of the script, the first answer wins; and back to a view', async () => {
  const host = createExtensionHost();
  const browser = fakeBrowser();
  const link = host[ATTACH](browser);
  const view = fakeView(7);
  const contexts = {};
  await host.install(
    extension('pw', (context) => {
      contexts.pw = context;
      context.onMessage(() => undefined);
      context.onMessage(async (message, sender) => ({ echo: message, url: sender.url }));
      context.onMessage(() => 'never');
    }),
  );
  await host.install(extension('other', () => {}));
  const answer = await link.message(
    { extension: 'pw', url: 'https://a.test/', message: '{"q":1}' },
    view,
  );
  assert.deepEqual(answer, { echo: { q: 1 }, url: 'https://a.test/' });
  assert.equal(await link.message({ extension: 'other', url: '', message: '1' }, view), undefined);
  await assert.rejects(link.message({ extension: 'none', url: '', message: '1' }, view));
  contexts.pw.postMessage(view, { fill: 'x' });
  assert.deepEqual(browser.posted, [[7, 'pw', { fill: 'x' }]]);
  await host.disable('pw');
  contexts.pw.postMessage(view, 'late');
  assert.equal(browser.posted.length, 1);
  await assert.rejects(link.message({ extension: 'pw', url: '', message: '1' }, view));
});
