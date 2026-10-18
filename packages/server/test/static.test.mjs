// serveStatic in process: headers, precompressed files, ETag, byte ranges, mounting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { coiHeaders, contentType, serveStatic } from '../dist/static.js';
import { request } from './helpers.mjs';

let site;
let server;
let port;
const body = Buffer.from('0123456789abcdefghij');

before(async () => {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-static-test-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html>hello');
  fs.writeFileSync(path.join(site, 'data.bin'), body);
  fs.writeFileSync(path.join(site, 'app.js'), 'console.log(1);'.repeat(50));
  fs.writeFileSync(path.join(site, 'app.js.gz'), 'gzip');
  fs.writeFileSync(path.join(site, 'app.js.br'), 'brotli');
  fs.mkdirSync(path.join(site, 'mounted'));
  fs.writeFileSync(path.join(site, 'mounted', 'x.txt'), 'mounted');
  server = http.createServer(async (req, res) => {
    const handled = req.url.startsWith('/mount/')
      ? await serveStatic(req, res, path.join(site, 'mounted'), {
          urlPath: req.url.slice('/mount'.length),
          corp: 'cross-origin',
        })
      : await serveStatic(req, res, site, {
          cacheControl: (p) => (p === '/data.bin' ? 'max-age=60' : 'no-cache'),
        });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server.close();
  fs.rmSync(site, { recursive: true, force: true });
});

test('coiHeaders and contentType', () => {
  assert.deepEqual(coiHeaders(), {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  assert.equal(
    coiHeaders({ corp: 'cross-origin' })['Cross-Origin-Resource-Policy'],
    'cross-origin',
  );
  assert.equal(contentType('a/engine.wasm'), 'application/wasm');
  assert.equal(contentType('INDEX.HTML'), 'text/html; charset=utf-8');
  assert.equal(contentType('x.unknown'), 'application/octet-stream');
});

test('index, security headers and cache control', async () => {
  const res = await request(port, '/');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '<!doctype html>hello');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal((await request(port, '/data.bin')).headers['cache-control'], 'max-age=60');
});

test('mounted root with its own urlPath and CORP', async () => {
  const res = await request(port, '/mount/x.txt');
  assert.equal(res.body.toString(), 'mounted');
  assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
});

test('precompressed files: br before gzip, per encoding ETag', async () => {
  const plain = await request(port, '/app.js');
  const br = await request(port, '/app.js', { headers: { 'Accept-Encoding': 'gzip, br' } });
  const gz = await request(port, '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.body.toString(), 'brotli');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.body.toString(), 'gzip');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['accept-ranges'], 'bytes');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.notEqual(plain.headers.etag, br.headers.etag);
  assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8');
});

test('ETag 304', async () => {
  const first = await request(port, '/data.bin');
  const cached = await request(port, '/data.bin', {
    headers: { 'If-None-Match': `"x", ${first.headers.etag}` },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
  const star = await request(port, '/data.bin', { headers: { 'If-None-Match': '*' } });
  assert.equal(star.status, 304);
  const other = await request(port, '/data.bin', { headers: { 'If-None-Match': '"other"' } });
  assert.equal(other.status, 200);
});

test('byte ranges', async () => {
  const range = async (value, headers = {}) =>
    request(port, '/data.bin', { headers: { Range: value, ...headers } });
  const part = await range('bytes=2-5');
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), '2345');
  assert.equal(part.headers['content-range'], `bytes 2-5/${body.length}`);
  assert.equal(part.headers['content-length'], '4');
  const open = await range('bytes=15-');
  assert.equal(open.status, 206);
  assert.equal(open.body.toString(), 'fghij');
  const suffix = await range('bytes=-3');
  assert.equal(suffix.body.toString(), 'hij');
  const clamped = await range('bytes=18-100');
  assert.equal(clamped.body.toString(), 'ij');
  const unsatisfiable = await range('bytes=50-60');
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers['content-range'], `bytes */${body.length}`);
  const multiple = await range('bytes=0-1,4-5');
  assert.equal(multiple.status, 200);
  assert.equal(multiple.body.length, body.length);
  const etag = (await request(port, '/data.bin')).headers.etag;
  assert.equal((await range('bytes=0-1', { 'If-Range': etag })).status, 206);
  assert.equal((await range('bytes=0-1', { 'If-Range': '"old"' })).status, 200);
  const compressed = await request(port, '/app.js', {
    headers: { Range: 'bytes=0-6', 'Accept-Encoding': 'br' },
  });
  assert.equal(compressed.status, 206, 'ranges use the uncompressed file');
  assert.equal(compressed.headers['content-encoding'], undefined);
  assert.equal(compressed.body.toString(), 'console');
  const head = await request(port, '/data.bin', {
    method: 'HEAD',
    headers: { Range: 'bytes=0-1' },
  });
  assert.equal(head.status, 206);
  assert.equal(head.body.length, 0);
});

test('missing, traversal, other methods and broken URLs are not served', async () => {
  for (const bad of [
    '/missing.js',
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%zz',
    '/a%00b',
  ])
    assert.equal((await request(port, bad)).status, 404, bad);
  assert.equal((await request(port, '/data.bin', { method: 'POST' })).status, 404);
});
