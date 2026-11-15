import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../dist/sw/download-sw.js', import.meta.url), 'utf8');

// The download part in a sandbox: messages from a page client, navigations of its frame
function worker(scope) {
  const listeners = {};
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
  };
  vm.runInContext(
    source,
    vm.createContext({ self, URL, Response, Headers, ReadableStream, Error, String, Number }),
  );
  const posted = [];
  // Through JSON: objects of the sandbox have other prototypes
  const client = {
    id: 'page',
    postMessage: (data) => posted.push(JSON.parse(JSON.stringify(data))),
  };
  const message = (data) => listeners.message({ data, source: client });
  const fetch = (url, mode = 'navigate') => {
    let response = null;
    listeners.fetch({
      request: { url, mode },
      respondWith(value) {
        response = value;
      },
    });
    return response;
  };
  return { message, fetch, posted };
}

const bytes = (text) => new TextEncoder().encode(text).buffer;

test('streams the posted bytes as an attachment to the frame', async () => {
  const sw = worker('https://site.example/app/');
  sw.message({
    bl: 'download-open',
    instance: 'one',
    id: 4,
    filename: 'Bericht über "alles".pdf',
    mime: 'application/pdf',
  });
  sw.message({ bl: 'download-data', instance: 'one', id: 4, bytes: bytes('early ') });
  const response = await sw.fetch('https://site.example/app/bl-download/one/4/x.pdf');
  assert.deepEqual(sw.posted, [
    { bl: 'download-opened', instance: 'one', id: 4 },
    { bl: 'download-started', instance: 'one', id: 4 },
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(
    response.headers.get('Content-Disposition'),
    `attachment; filename="Bericht _ber _alles_.pdf"; filename*=UTF-8''Bericht%20%C3%BCber%20%22alles%22.pdf`,
  );
  assert.equal(response.headers.get('Content-Security-Policy'), 'sandbox');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(response.headers.get('Content-Length'), null);
  sw.message({ bl: 'download-data', instance: 'one', id: 4, bytes: bytes('late') });
  sw.message({ bl: 'download-end', instance: 'one', id: 4, error: '' });
  assert.equal(await response.text(), 'early late');
  // Once only: the URL answers nothing more
  assert.equal((await sw.fetch('https://site.example/app/bl-download/one/4/x.pdf')).status, 404);
});

test('an error fails the stream of the host download', async () => {
  const sw = worker('https://site.example/');
  sw.message({ bl: 'download-open', instance: 'i', id: 1, filename: 'a.bin', mime: '' });
  const response = await sw.fetch('https://site.example/bl-download/i/1/a.bin');
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  sw.message({ bl: 'download-data', instance: 'i', id: 1, bytes: bytes('part') });
  sw.message({ bl: 'download-end', instance: 'i', id: 1, error: 'Cancelled' });
  await assert.rejects(response.arrayBuffer());
});

test('a cancel in the host browser reaches the page', async () => {
  const sw = worker('https://site.example/');
  sw.message({ bl: 'download-open', instance: 'i', id: 2, filename: 'a.bin', mime: '' });
  const response = await sw.fetch('https://site.example/bl-download/i/2/a.bin');
  await response.body.cancel();
  assert.deepEqual(sw.posted.at(-1), { bl: 'download-cancel', instance: 'i', id: 2 });
});

test('ignores other requests, answers unknown downloads with 404', async () => {
  const sw = worker('https://site.example/app/');
  assert.equal(sw.fetch('https://site.example/app/index.html'), null);
  assert.equal(sw.fetch('https://site.example/bl-download/i/1/x'), null);
  assert.equal(sw.fetch('https://other.example/app/bl-download/i/1/x'), null);
  assert.equal((await sw.fetch('https://site.example/app/bl-download/i/9/x')).status, 404);
  // Only the navigation of the frame gets the file
  sw.message({ bl: 'download-open', instance: 'i', id: 3, filename: 'a', mime: 'text/html' });
  assert.equal((await sw.fetch('https://site.example/app/bl-download/i/3/a', 'cors')).status, 404);
  assert.equal((await sw.fetch('https://site.example/app/bl-download/i/3/a')).status, 200);
  // An abandoned download (no answer in time) is gone
  sw.message({ bl: 'download-open', instance: 'i', id: 5, filename: 'b', mime: '' });
  sw.message({ bl: 'download-end', instance: 'i', id: 5, error: 'No answer' });
  assert.equal((await sw.fetch('https://site.example/app/bl-download/i/5/b')).status, 404);
});
