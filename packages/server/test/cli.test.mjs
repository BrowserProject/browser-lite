// The browser-lite-server command: configuration from the environment, tokens, origins, proxy
// addresses, local mode, the site (headers, compression, ETag, broken URLs, aborted downloads),
// /healthz and graceful SIGTERM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { signToken } from '../dist/token.js';
import { rawRequest, request, sleep, startCli, stopCli, tcpServer } from './helpers.mjs';
import { DATA, open, withToken } from './wisp-client.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'test-secret-0123456789abcdef0123456789';

describe('configuration errors end with code 1', () => {
  for (const [name, env] of [
    ['short token', { RELAY_TOKEN: 'short' }],
    ['short secret', { RELAY_SECRET: 'short' }],
    ['invalid port', { PORT: 'x' }],
    ['invalid origin', { RELAY_ALLOWED_ORIGINS: 'not a url' }],
    ['invalid proxy count', { RELAY_TRUST_PROXY: '-1' }],
  ]) {
    test(name, async () => {
      const cli = await startCli(env);
      assert.equal(cli.ready, false);
      assert.equal(cli.code, 1, cli.log);
    });
  }

  test('port in use', async () => {
    const first = await startCli();
    const second = await startCli({ PORT: String(first.port) });
    assert.equal(second.ready, false);
    assert.equal(second.code, 1);
    await stopCli(first);
  });
});

describe('tokens', () => {
  test('static token: wrong and missing refused, right accepted, never logged', async () => {
    const cli = await startCli({ RELAY_TOKEN: TOKEN });
    try {
      const url = `ws://127.0.0.1:${cli.port}/wisp/`;
      assert.equal((await open(url, { protocols: withToken('wrong') })).status, 403);
      assert.equal((await open(url)).status, 403);
      assert.equal((await open(`${url}?token=${TOKEN}`)).status, 403, 'never in the URL');
      const client = await open(url, { protocols: withToken(TOKEN) });
      assert.ok(client.ws);
      assert.equal(client.ws.protocol, 'wisp', 'the token is never echoed');
      await client.close();
      const bearer = await open(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.ok(bearer.ws, 'Authorization header for non-browser clients');
      await bearer.close();
      const other = `ws://127.0.0.1:${cli.port}/other/`;
      assert.equal((await open(other, { protocols: withToken(TOKEN) })).status, 404);
    } finally {
      assert.equal((await stopCli(cli)).code, 0);
    }
    assert.ok(!cli.log.includes(TOKEN));
  });

  test('profile takes the token only as Authorization: Bearer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lite-profile-'));
    const cli = await startCli({ RELAY_TOKEN: TOKEN, PROFILE_DIR: dir });
    try {
      const info = (urlPath, headers) => request(cli.port, urlPath, { headers });
      assert.equal((await info('/profile/info')).status, 403);
      assert.equal((await info(`/profile/info?token=${TOKEN}`)).status, 403);
      const bearer = { authorization: `Bearer ${TOKEN}` };
      assert.equal((await info('/profile/info', bearer)).status, 200);
    } finally {
      await stopCli(cli);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('signed tokens with RELAY_SECRET open only their audience', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lite-profile-'));
    const cli = await startCli({ RELAY_SECRET: SECRET, PROFILE_DIR: dir });
    try {
      const url = `ws://127.0.0.1:${cli.port}/wisp/`;
      const sign = (audience, secret = SECRET) => signToken({ secret, ttlSeconds: 60, audience });
      const client = await open(url, { protocols: withToken(sign('relay')) });
      assert.ok(client.ws);
      await client.close();
      assert.equal((await open(url, { protocols: withToken(sign('profile')) })).status, 403);
      const foreign = sign('relay', `${SECRET}x`);
      assert.equal((await open(url, { protocols: withToken(foreign) })).status, 403);
      assert.equal((await open(url)).status, 403);
      const info = (token) =>
        request(cli.port, '/profile/info', { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await info(sign('profile'))).status, 200);
      assert.equal(
        (await info(sign('relay'))).status,
        403,
        'a relay token never opens the profile',
      );
    } finally {
      await stopCli(cli);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ALLOWED_HOSTS: relay and profile only under IP addresses, localhost and listed names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lite-profile-'));
    const cli = await startCli({ PROFILE_DIR: dir, ALLOWED_HOSTS: 'browser.example' });
    try {
      const url = `ws://127.0.0.1:${cli.port}/wisp/`;
      const status = async (host) => {
        const result = await open(url, { headers: { host }, origin: `http://${host}` });
        if (result.ws) await result.close();
        return result.ws ? 101 : result.status;
      };
      assert.equal(await status(`127.0.0.1:${cli.port}`), 101);
      assert.equal(await status('browser.example'), 101);
      assert.equal(await status('rebound.evil.example'), 403, 'DNS rebinding');
      const info = (host) => request(cli.port, '/profile/info', { headers: { host } });
      assert.equal((await info('browser.example')).status, 200);
      assert.equal((await info('rebound.evil.example')).status, 403);
    } finally {
      await stopCli(cli);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relay settings', () => {
  let echo;
  before(async () => {
    echo = await tcpServer((socket) => socket.pipe(socket));
  });
  after(() => echo.server.close());

  test('open relay blocks local targets, RELAY_ALLOW_LOCAL allows them on any port', async () => {
    const strict = await startCli();
    const local = await startCli({ RELAY_ALLOW_LOCAL: '1' });
    try {
      const a = await open(`ws://127.0.0.1:${strict.port}/wisp/`);
      a.connectTCP(1, '127.0.0.1', echo.port);
      assert.equal(await a.closeReason(1), 0x48);
      await a.close();
      const b = await open(`ws://127.0.0.1:${local.port}/wisp/`);
      b.connectTCP(1, '127.0.0.1', echo.port);
      b.send(DATA, 1, Buffer.from('hi'));
      await b.waitFor((p) => p.type === DATA && p.streamId === 1);
      assert.equal(b.data(1).toString(), 'hi');
      await b.close();
      assert.match(local.log, /RELAY_ALLOW_LOCAL/);
    } finally {
      await stopCli(strict);
      await stopCli(local);
    }
  });

  test('RELAY_ALLOWED_ORIGINS replaces the same host default', async () => {
    const plain = await startCli();
    const listed = await startCli({
      RELAY_ALLOWED_ORIGINS: 'https://app.example, http://other.example',
    });
    const status = async (port, origin) => {
      const result = await open(`ws://127.0.0.1:${port}/wisp/`, { headers: { Origin: origin } });
      if (result.ws) await result.close();
      return result.ws ? 101 : result.status;
    };
    try {
      assert.equal(await status(plain.port, `http://127.0.0.1:${plain.port}`), 101);
      assert.equal(await status(plain.port, 'https://app.example'), 403);
      assert.equal(await status(listed.port, 'https://app.example'), 101);
      assert.equal(await status(listed.port, 'http://other.example'), 101);
      assert.equal(await status(listed.port, `http://127.0.0.1:${listed.port}`), 403);
    } finally {
      await stopCli(plain);
      await stopCli(listed);
    }
  });

  test('RELAY_TRUST_PROXY counts connections per forwarded client', async () => {
    const direct = await startCli();
    const proxied = await startCli({ RELAY_TRUST_PROXY: '1' });
    const connect = (port, ip) =>
      open(`ws://127.0.0.1:${port}/wisp/`, { headers: { 'X-Forwarded-For': ip } });
    try {
      const held = [];
      for (let i = 0; i < 16; i++) held.push(await connect(direct.port, `203.0.113.${i}`));
      assert.ok(held.every((c) => c.ws));
      assert.equal((await connect(direct.port, '203.0.113.99')).status, 429, 'header ignored');
      const forwarded = [];
      for (let i = 0; i < 16; i++)
        forwarded.push(await connect(proxied.port, `1.2.3.4, 203.0.113.${i}`));
      assert.ok(
        forwarded.every((c) => c.ws),
        'each forwarded client has its own limit',
      );
      for (let i = 0; i < 16; i++)
        forwarded.push(await connect(proxied.port, `9.9.9.${i}, 198.51.100.1`));
      assert.equal(
        (await connect(proxied.port, '8.8.8.8, 198.51.100.1')).status,
        429,
        'only the entry the proxy appended counts',
      );
      for (const c of [...held, ...forwarded]) if (c.ws) await c.close();
    } finally {
      await stopCli(direct);
      await stopCli(proxied);
    }
  });
});

describe('site', () => {
  let site;
  let cli;
  before(async () => {
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cli-test-'));
    fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html>hello');
    fs.writeFileSync(path.join(site, 'a.js'), 'console.log("a");'.repeat(100));
    fs.writeFileSync(path.join(site, 'a.js.br'), 'brotli');
    // Large enough that a download does not vanish in the socket buffer at once
    fs.mkdirSync(path.join(site, 'engine'));
    fs.writeFileSync(path.join(site, 'engine', 'big.wasm'), '');
    fs.truncateSync(path.join(site, 'engine', 'big.wasm'), 64 * 1024 * 1024);
    cli = await startCli({ SITE_DIR: site });
  });
  after(async () => {
    const stopped = await stopCli(cli);
    fs.rmSync(site, { recursive: true, force: true });
    assert.equal(stopped.code, 0, 'SIGTERM ends cleanly');
  });

  test('/healthz', async () => {
    const health = await request(cli.port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.toString(), 'ok\n');
  });

  test('index with COOP/COEP, ETag and 304', async () => {
    const index = await request(cli.port, '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(index.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.ok(index.headers.etag && index.headers['last-modified']);
    const cached = await request(cli.port, '/', {
      headers: { 'If-None-Match': `"x", ${index.headers.etag}` },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers['cache-control'], 'no-cache');
    assert.equal(
      (await request(cli.port, '/', { headers: { 'If-None-Match': '"other"' } })).status,
      200,
    );
  });

  test('brotli, HEAD and immutable engine files', async () => {
    const plain = await request(cli.port, '/a.js');
    const br = await request(cli.port, '/a.js', { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.body.toString(), 'brotli');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.notEqual(plain.headers.etag, br.headers.etag);
    const head = await request(cli.port, '/a.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(plain.body.length));
    const engine = await request(cli.port, '/engine/big.wasm', { method: 'HEAD' });
    assert.ok(engine.headers['cache-control'].includes('immutable'));
    assert.equal(engine.headers['content-type'], 'application/wasm');
    const range = await request(cli.port, '/engine/big.wasm', { headers: { Range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.length, 10);
  });

  test('missing files, traversal and broken URLs', async () => {
    for (const bad of ['/..%2f..%2fetc%2fpasswd', '/../../etc/passwd', '/missing.js'])
      assert.equal((await request(cli.port, bad)).status, 404, bad);
    for (const bad of ['/%zz', '/%E0'])
      assert.equal((await request(cli.port, bad)).status, 400, bad);
    const upgrade = await rawRequest(
      cli.port,
      'GET //[x HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    assert.ok(upgrade.answer.startsWith('HTTP/1.1 400'), upgrade.answer.split('\r\n')[0]);
    assert.ok(upgrade.closed);
  });

  test('aborted downloads close their files', async (t) => {
    const fdDir = `/proc/${cli.child.pid}/fd`;
    if (!fs.existsSync(fdDir)) {
      t.skip('no /proc');
      return;
    }
    const before = fs.readdirSync(fdDir).length;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const req = http.get(
          { host: '127.0.0.1', port: cli.port, path: '/engine/big.wasm', agent: false },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', resolve);
      });
    }
    await sleep(500);
    const afterCount = fs.readdirSync(fdDir).length;
    assert.ok(afterCount <= before + 2, `fds ${before} -> ${afterCount}`);
    assert.equal((await request(cli.port, '/healthz')).status, 200, 'still running');
  });
});

test('SIGTERM closes open relay connections and exits with 0', async () => {
  const cli = await startCli({ RELAY_ALLOW_LOCAL: '1' });
  const client = await open(`ws://127.0.0.1:${cli.port}/wisp/`);
  const started = Date.now();
  const stopped = await stopCli(cli);
  assert.equal(stopped.code, 0);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.equal(await client.closed, 1001);
});
