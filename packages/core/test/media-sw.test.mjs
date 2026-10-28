import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../dist/sw/media-sw.js', import.meta.url), 'utf8');

// The service worker in a sandbox with fake clients that answer like the core media service
function worker(scope, pages) {
  const listeners = {};
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    clients: {
      get: async (id) => pages.find((page) => page.id === id),
      matchAll: async () => pages,
      claim: async () => {
        self.claimed = (self.claimed ?? 0) + 1;
      },
    },
  };
  const globals = {
    self,
    URL,
    Response,
    Headers,
    ReadableStream,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.runInContext(source, vm.createContext(globals));
  const waits = [];
  const message = (data, client) =>
    listeners.message({ data, source: client, waitUntil: (promise) => waits.push(promise) });
  const fetch = (url, headers = {}, clientId = '') => {
    let response = null;
    listeners.fetch({
      request: new Request(url, { headers }),
      clientId,
      respondWith(promise) {
        response = promise;
      },
    });
    return response;
  };
  return { message, fetch, self, waits };
}

function page(id, instance, file, log) {
  const client = {
    id,
    sw: null,
    postMessage(data) {
      log.push({ to: id, ...data });
      if (data.instance !== instance || data.bl !== 'media-fetch') return;
      const end = Math.min(data.end, file.length - 1);
      const reply = (type, extra) =>
        client.sw.message({ bl: 'media-data', instance, id: data.id, type, ...extra }, client);
      setTimeout(() => {
        reply('head', {
          data: {
            status: 206,
            range: `bytes ${data.start}-${end}/${file.length}`,
            type: 'audio/wav',
          },
        });
        reply('data', { bytes: file.slice(data.start, end + 1).buffer });
        reply('end', {});
      });
    },
  };
  return client;
}

test('ignores requests outside its prefix', () => {
  const sw = worker('https://site.example/app/', []);
  assert.equal(sw.fetch('https://site.example/app/index.html'), null);
  assert.equal(sw.fetch('https://site.example/bl-media/i/1/x'), null);
  assert.equal(sw.fetch('https://other.example/app/bl-media/i/1/x'), null);
  assert.equal(sw.fetch('https://site.example/app/bl-media/i/notanumber/x'), null);
});

test('serves a range in chunks from the page of the instance', async () => {
  const file = new Uint8Array(3 * 1024 * 1024 + 100).map((_, i) => i % 251);
  const log = [];
  const pages = [page('a', 'one', file, log), page('b', 'two', file, log)];
  const sw = worker('https://site.example/app/', pages);
  for (const client of pages) client.sw = sw;
  sw.message({ bl: 'media-hello', instance: 'two' }, pages[1]);
  const response = await sw.fetch('https://site.example/app/bl-media/two/7/abc', {
    Range: 'bytes=0-',
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), `bytes 0-${file.length - 1}/${file.length}`);
  assert.equal(response.headers.get('Content-Length'), String(file.length));
  assert.equal(response.headers.get('Content-Type'), 'audio/wav');
  const body = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(body, file);
  const fetches = log.filter((entry) => entry.bl === 'media-fetch');
  assert.ok(fetches.length >= 2, 'more than one chunk');
  assert.ok(fetches.every((entry) => entry.to === 'b' && entry.player === 7));
});

test('without a known page all windows are asked, the instance answers', async () => {
  const file = new Uint8Array(1000).map((_, i) => i % 7);
  const log = [];
  const pages = [page('a', 'one', file, log), page('b', 'two', file, log)];
  const sw = worker('https://site.example/', pages);
  for (const client of pages) client.sw = sw;
  const response = await sw.fetch('https://site.example/bl-media/one/3/x', {
    Range: 'bytes=100-199',
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 100-199/1000');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), file.slice(100, 200));
  assert.deepEqual(
    new Set(log.filter((entry) => entry.bl === 'media-fetch').map((entry) => entry.to)),
    new Set(['a', 'b']),
  );
});

test('no page at all: 503', async () => {
  const sw = worker('https://site.example/', []);
  const response = await sw.fetch('https://site.example/bl-media/one/3/x');
  assert.equal(response.status, 503);
});

test('a page that is not controlled gets claimed on request', async () => {
  const sw = worker('https://site.example/', []);
  sw.message({ bl: 'claim' }, null);
  await Promise.all(sw.waits);
  assert.equal(sw.self.claimed, 1);
});
