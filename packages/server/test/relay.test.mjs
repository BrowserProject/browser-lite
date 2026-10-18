// Relay at the protocol level with a raw Wisp client: upgrade checks (authorize, origins, host
// names, subprotocols, limits per client address), framing errors, close reasons, SSRF rules,
// stream limits, queued client data, keepalive, shutdown and two relays with different policies
// in one process.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, describe, test } from 'node:test';
import { createRelay } from '../dist/index.js';
import {
  closedPort,
  documentationPrefixUnreachable,
  sleep,
  startRelays,
  tcpServer,
  waitUntil,
} from './helpers.mjs';
import { CLOSE, CONTINUE, DATA, open, withToken } from './wisp-client.mjs';

const INVALID = 0x41;
const UNREACHABLE_HOST = 0x42;
const REFUSED = 0x44;
const TIMEOUT = 0x47;
const BLOCKED = 0x48;
const THROTTLED = 0x49;
const ADDRESS_UNREACHABLE = 0x4a;
const VOLUNTARY = 0x02;
const NETWORK_ERROR = 0x03;

/** Ports of local test servers are random: allow them all. */
const local = { authorize: () => true, policy: { allowPrivateAddresses: true, ports: 'any' } };

let echo;
before(async () => {
  echo = await tcpServer((socket) => socket.pipe(socket));
});
after(() => echo.server.close());

describe('options', () => {
  test('authorize is required', () => {
    assert.throws(() => createRelay({}), TypeError);
    assert.throws(() => createRelay(), TypeError);
    assert.throws(() => createRelay({ authorize: true }), TypeError);
  });

  test('invalid policy values are rejected', () => {
    const authorize = () => true;
    assert.throws(() => createRelay({ authorize, policy: { ports: [0] } }), TypeError);
    assert.throws(() => createRelay({ authorize, policy: { ports: 'all' } }), TypeError);
    assert.throws(() => createRelay({ authorize, policy: { maxPayload: -1 } }), TypeError);
    assert.throws(() => createRelay({ authorize, policy: { streamsPerHost: 1.5 } }), TypeError);
  });
});

describe('upgrade', () => {
  test('authorize decides, also async, and errors refuse', async () => {
    let calls = 0;
    const seen = [];
    const stack = await startRelays([
      {
        path: '/yes/',
        authorize: async (_req, url) => {
          calls++;
          seen.push(url.searchParams.get('token'));
          await sleep(10);
          return true;
        },
      },
      { path: '/no/', authorize: () => false },
      { path: '/truthy/', authorize: () => 'yes' },
      {
        path: '/throws/',
        authorize: () => {
          throw new Error('boom');
        },
        logger: { warn() {}, error() {} },
      },
    ]);
    try {
      const yes = await open(stack.url('/yes/?token=abc'));
      assert.ok(yes.ws, 'async authorize true connects');
      assert.equal(yes.firstType, CONTINUE);
      assert.equal(yes.bufferSize, 128);
      assert.deepEqual(seen, ['abc']);
      await yes.close();
      assert.equal((await open(stack.url('/no/'))).status, 403);
      assert.equal((await open(stack.url('/truthy/'))).status, 403, 'only true authorizes');
      assert.equal((await open(stack.url('/throws/'))).status, 403);
      assert.equal(calls, 1);
    } finally {
      await stack.close();
    }
  });

  test('handleUpgrade returns false for other paths', async () => {
    const relay = createRelay({ authorize: () => true });
    const fake = { url: '/other/', headers: {}, socket: {} };
    assert.equal(relay.handleUpgrade(fake, {}, Buffer.alloc(0)), false);
    assert.equal(relay.handleUpgrade({ ...fake, url: '//[x' }, {}, Buffer.alloc(0)), false);
    await relay.close();
  });

  test('origins: default same host, list, any, function', async () => {
    const stack = await startRelays([
      { path: '/default/', authorize: () => true },
      { path: '/list/', authorize: () => true, allowedOrigins: ['https://app.example'] },
      { path: '/any/', authorize: () => true, allowedOrigins: ['*'] },
      {
        path: '/fn/',
        authorize: () => true,
        allowedOrigins: (origin) => origin === undefined || origin.endsWith('.good.example'),
      },
    ]);
    const status = async (urlPath, headers) => {
      const result = await open(stack.url(urlPath), { headers });
      if (result.ws) {
        await result.close();
        return 101;
      }
      return result.status;
    };
    try {
      const host = `127.0.0.1:${stack.port}`;
      assert.equal(await status('/default/', {}), 101, 'no Origin: non-browser client');
      assert.equal(await status('/default/', { Origin: `http://${host}` }), 101);
      assert.equal(await status('/default/', { Origin: `http://127.0.0.1:1` }), 403);
      assert.equal(await status('/default/', { Origin: 'https://evil.example' }), 403);
      assert.equal(await status('/default/', { Origin: 'null' }), 403);
      assert.equal(
        await status('/default/', { Origin: 'http://site.example', Host: 'site.example:80' }),
        101,
        'default port in Host',
      );
      assert.equal(
        await status('/default/', { Origin: 'https://Site.Example', Host: 'site.example' }),
        101,
      );
      assert.equal(await status('/list/', { Origin: 'https://app.example' }), 101);
      assert.equal(await status('/list/', { Origin: `http://${host}` }), 403);
      assert.equal(await status('/any/', { Origin: 'https://whatever.example' }), 101);
      assert.equal(await status('/fn/', { Origin: 'https://a.good.example' }), 101);
      assert.equal(await status('/fn/', { Origin: 'https://bad.example' }), 403);
    } finally {
      await stack.close();
    }
  });

  test('hosts: IP addresses, localhost and listed names only', async () => {
    const stack = await startRelays([
      { path: '/any/', authorize: () => true },
      { path: '/listed/', authorize: () => true, hosts: ['browser.example', '.ts.net'] },
    ]);
    const status = async (urlPath, host) => {
      const result = await open(stack.url(urlPath), {
        headers: { Host: host },
        origin: `http://${host}`,
      });
      if (result.ws) await result.close();
      return result.ws ? 101 : result.status;
    };
    try {
      assert.equal(await status('/any/', 'rebound.evil.example'), 101, 'default: every host');
      for (const [host, expected] of [
        [`127.0.0.1:${stack.port}`, 101],
        ['localhost', 101],
        ['[::1]:8080', 101],
        ['browser.example', 101],
        ['Box.Tail1234.TS.NET', 101],
        ['rebound.evil.example', 403],
        ['ts.net', 403],
      ])
        assert.equal(await status('/listed/', host), expected, host);
    } finally {
      await stack.close();
    }
  });

  test('subprotocols: answers wisp, never the token entry', async () => {
    const stack = await startRelays([{ authorize: () => true }]);
    try {
      const both = await open(stack.url(), { protocols: withToken('some-token') });
      assert.equal(both.ws.protocol, 'wisp');
      await both.close();
      const none = await open(stack.url());
      assert.equal(none.ws.protocol, '');
      await none.close();
    } finally {
      await stack.close();
    }
  });

  test('connectionsPerIp, with clientAddress behind a proxy', async () => {
    const stack = await startRelays([
      { path: '/direct/', authorize: () => true, policy: { connectionsPerIp: 2 } },
      {
        path: '/proxied/',
        authorize: () => true,
        policy: { connectionsPerIp: 2 },
        clientAddress: (req) =>
          String(req.headers['x-forwarded-for'] ?? '')
            .split(',')
            .at(-1)
            .trim(),
      },
    ]);
    try {
      const a = await open(stack.url('/direct/'));
      const b = await open(stack.url('/direct/'));
      assert.ok(a.ws && b.ws);
      assert.equal((await open(stack.url('/direct/'))).status, 429);
      await a.close();
      assert.ok(
        await waitUntil(async () => {
          const again = await open(stack.url('/direct/'));
          if (again.ws) await again.close();
          return Boolean(again.ws);
        }, 2000),
        'a closed connection frees its place',
      );
      await b.close();

      const as = (ip) => open(stack.url('/proxied/'), { headers: { 'X-Forwarded-For': ip } });
      const first = [await as('203.0.113.1'), await as('203.0.113.1')];
      assert.ok(first.every((c) => c.ws));
      assert.equal((await as('203.0.113.1')).status, 429, 'same client behind the proxy');
      const other = await as('198.51.100.7, 203.0.113.9');
      assert.ok(other.ws, 'another client behind the same proxy has its own limit');
      assert.equal((await as('::ffff:203.0.113.1')).status, 429, 'IPv4-mapped counts as IPv4');
      for (const c of [...first, other]) await c.close();
    } finally {
      await stack.close();
    }
  });
});

describe('framing', () => {
  let stack;
  before(async () => {
    stack = await startRelays([{ ...local, policy: { ...local.policy, maxPayload: 4096 } }]);
  });
  after(() => stack.close());

  test('maxPayload closes with 1009', async () => {
    const client = await open(stack.url());
    client.connectTCP(1, '127.0.0.1', echo.port);
    client.send(DATA, 1, Buffer.alloc(4000));
    await client.waitFor((p) => p.type === DATA && p.streamId === 1);
    client.send(DATA, 1, Buffer.alloc(4096));
    assert.equal(await client.closed, 1009);
  });

  test('text frames close with 1003', async () => {
    const client = await open(stack.url());
    client.ws.send('hello');
    assert.equal(await client.closed, 1003);
  });

  test('packets shorter than the header close with 1002', async () => {
    const client = await open(stack.url());
    client.ws.send(Buffer.from([0x01, 0, 0]));
    assert.equal(await client.closed, 1002);
  });

  test('CONNECT on stream 0 or on an open stream closes with 1002', async () => {
    const zero = await open(stack.url());
    zero.connectTCP(0, '127.0.0.1', echo.port);
    assert.equal(await zero.closed, 1002);
    const twice = await open(stack.url());
    twice.connectTCP(5, '127.0.0.1', echo.port);
    twice.connectTCP(5, '127.0.0.1', echo.port);
    assert.equal(await twice.closed, 1002);
  });

  test('short CONNECT is invalid; unknown types and streams are ignored', async () => {
    const client = await open(stack.url());
    client.send(0x01, 3, Buffer.from([0x01, 80]));
    assert.equal(await client.closeReason(3), INVALID);
    client.send(DATA, 99, Buffer.from('nobody'));
    client.send(CLOSE, 98, Buffer.from([2]));
    client.send(CONTINUE, 97, Buffer.alloc(4));
    client.send(0x05, 0, Buffer.from([2, 0]));
    client.send(0x7f, 1, Buffer.alloc(0));
    client.connectTCP(4, '127.0.0.1', echo.port);
    client.send(DATA, 4, Buffer.from('still alive'));
    await client.waitFor((p) => p.type === DATA && p.streamId === 4);
    assert.equal(client.data(4).toString(), 'still alive');
    assert.equal(client.closeCode, null);
    await client.close();
  });

  test('a client ignoring flow control loses the stream', async () => {
    const { server, port } = await tcpServer((socket) => socket.pause());
    const client = await open(stack.url());
    client.connectTCP(1, '127.0.0.1', port);
    const chunk = Buffer.alloc(4000);
    for (let i = 0; i < 20000 && !client.packets.some((p) => p.type === CLOSE); i++) {
      client.send(DATA, 1, chunk);
      if (i % 100 === 0) await sleep(5);
    }
    assert.equal(await client.closeReason(1), NETWORK_ERROR);
    await client.close();
    server.close();
  });
});

describe('queued client data', () => {
  let stack;
  let target;
  before(async () => {
    stack = await startRelays([{ ...local, policy: { ...local.policy, streamsPerConnection: 2 } }]);
    target = await tcpServer((socket) => socket.pause());
  });
  after(async () => {
    target.server.close();
    await stack.close();
  });

  test('a target that never reads: the stream fails long before 512 large packets', async () => {
    const client = await open(stack.url());
    client.connectTCP(1, '127.0.0.1', target.port);
    await sleep(100);
    const chunk = Buffer.alloc(64 * 1024);
    let sent = 0;
    while (sent < 1024 && !client.packets.some((p) => p.type === CLOSE && p.streamId === 1)) {
      client.send(DATA, 1, chunk);
      if (++sent % 16 === 0) await sleep(2);
    }
    assert.equal(await client.closeReason(1), NETWORK_ERROR);
    // 16 MiB (2 * 128 packets) in the relay plus the socket buffers of the kernel
    assert.ok(sent < 448, `${sent} packets of 64 KiB sent before CLOSE`);
    await client.close();
  });

  test('a stream closed by the client counts until its socket is gone', async () => {
    const client = await open(stack.url());
    client.connectTCP(1, '127.0.0.1', target.port);
    await sleep(100);
    for (let i = 0; i < 100; i++) client.send(DATA, 1, Buffer.alloc(64 * 1024));
    client.send(CLOSE, 1, Buffer.from([VOLUNTARY]));
    client.connectTCP(2, '127.0.0.1', echo.port);
    client.connectTCP(3, '127.0.0.1', echo.port);
    assert.equal(await client.closeReason(3), THROTTLED, 'draining stream 1 and stream 2');
    client.send(DATA, 2, Buffer.from('ok'));
    assert.ok(await waitUntil(() => client.data(2).toString() === 'ok', 2000));
    await client.close();
  });
});

describe('streams', () => {
  let stack;
  let client;
  before(async () => {
    stack = await startRelays([
      { ...local, policy: { ...local.policy, streamsPerConnection: 6, streamsPerHost: 3 } },
    ]);
    client = await open(stack.url());
  });
  after(async () => {
    await client.close();
    await stack.close();
  });

  test('echo with flow control credit', async () => {
    client.connectTCP(1, '127.0.0.1', echo.port);
    const total = 300;
    for (let i = 0; i < total; i++) {
      if (i && i % 100 === 0)
        await client.waitFor(
          (p) => p.type === CONTINUE && p.streamId === 1 && p.payload.readUInt32LE(0) > 0,
        );
      client.send(DATA, 1, Buffer.alloc(100, i & 0xff));
    }
    assert.ok(await waitUntil(() => client.data(1).length === total * 100, 5000));
    assert.ok(client.packets.some((p) => p.type === CONTINUE && p.streamId === 1));
    client.send(CLOSE, 1, Buffer.from([VOLUNTARY]));
  });

  test('close reasons: refused, name not resolved, empty target', async () => {
    client.connectTCP(10, '127.0.0.1', await closedPort());
    assert.equal(await client.closeReason(10), REFUSED);
    client.connectTCP(11, 'nonexistent.invalid', 80);
    assert.equal(await client.closeReason(11), UNREACHABLE_HOST);
    client.connectTCP(12, '', 0);
    assert.equal(await client.closeReason(12, 1000), INVALID);
    client.connectTCP(13, 'example.org', 0);
    assert.equal(await client.closeReason(13, 1000), INVALID);
    client.connectTCP(14, 'bad host', 80);
    assert.equal(await client.closeReason(14, 1000), INVALID);
  });

  test('address unreachable has its own reason', async (t) => {
    if (!(await documentationPrefixUnreachable())) {
      t.skip('2001:db8::1 is not unreachable at once on this machine');
      return;
    }
    client.connectTCP(15, '2001:db8::1', 80);
    assert.equal(await client.closeReason(15), ADDRESS_UNREACHABLE);
  });

  test('only TCP: other stream types are blocked', async () => {
    const udp = dgram.createSocket('udp4');
    let datagrams = 0;
    udp.on('message', () => datagrams++);
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
    let id = 20;
    for (const type of [0x02, 0x03, 0xff]) {
      client.connectTCP(id, '127.0.0.1', udp.address().port, type);
      assert.equal(await client.closeReason(id), BLOCKED, `type ${type}`);
      id++;
    }
    await sleep(200);
    assert.equal(datagrams, 0);
    udp.close();
  });

  test('a stream closed right after CONNECT never connects', async () => {
    let accepted = 0;
    const { server, port } = await tcpServer((socket) => {
      accepted++;
      socket.destroy();
    });
    for (let id = 30; id < 50; id++) {
      client.connectTCP(id, 'localhost', port);
      client.send(CLOSE, id, Buffer.from([VOLUNTARY]));
    }
    await sleep(1000);
    assert.equal(accepted, 0);
    server.close();
  });

  test('streams per host and per connection', async () => {
    const ids = [60, 61, 62];
    for (const id of ids) client.connectTCP(id, '127.0.0.1', echo.port);
    for (const id of ids) client.send(DATA, id, Buffer.from('x'));
    for (const id of ids) await client.waitFor((p) => p.type === DATA && p.streamId === id);
    client.connectTCP(63, '127.0.0.1', echo.port);
    assert.equal(await client.closeReason(63), THROTTLED);
    client.connectTCP(64, '127.0.0.1.', echo.port);
    assert.equal(await client.closeReason(64), THROTTLED, 'trailing dot is the same target');
    client.connectTCP(65, 'LOCALHOST', echo.port);
    client.connectTCP(66, 'localhost', echo.port);
    client.connectTCP(67, '127.1', echo.port);
    client.connectTCP(68, '127.2', echo.port);
    assert.equal(await client.closeReason(68), THROTTLED, 'streams per connection');
    client.send(CLOSE, 60, Buffer.from([VOLUNTARY]));
    // The place is free once the echo server has closed its side too
    await sleep(200);
    client.connectTCP(69, '127.0.0.1', echo.port);
    client.send(DATA, 69, Buffer.from('y'));
    assert.ok(await client.waitFor((p) => p.type === DATA && p.streamId === 69), 'place freed');
    for (const id of [61, 62, 65, 66, 67, 69]) client.send(CLOSE, id, Buffer.from([VOLUNTARY]));
    await sleep(100);
  });

  test('a closed stream also closes the socket to a target that keeps sending', async () => {
    let targetClosed = false;
    const { server, port } = await tcpServer(
      (socket) => {
        const chunk = Buffer.alloc(64 * 1024);
        const pump = () => {
          while (!socket.destroyed && socket.write(chunk));
        };
        socket.on('drain', pump);
        socket.on('error', () => {});
        socket.on('close', () => {
          targetClosed = true;
        });
        pump();
      },
      { allowHalfOpen: true },
    );
    client.connectTCP(70, '127.0.0.1', port);
    await client.waitFor((p) => p.type === DATA && p.streamId === 70);
    client.send(CLOSE, 70, Buffer.from([VOLUNTARY]));
    assert.ok(await waitUntil(() => targetClosed, 3000));
    server.close();
    client.packets.length = 0;
  });

  test('target closing ends the stream voluntarily', async () => {
    const { server, port } = await tcpServer((socket) => socket.end('bye'));
    client.connectTCP(71, '127.0.0.1', port);
    assert.equal(await client.closeReason(71), VOLUNTARY);
    assert.equal(client.data(71).toString(), 'bye');
    server.close();
  });

  test('a target reset after data also ends the stream voluntarily', async () => {
    const { server, port } = await tcpServer((socket) => {
      socket.on('error', () => {});
      socket.write('hello', () => setTimeout(() => socket.resetAndDestroy(), 50));
    });
    try {
      client.connectTCP(73, '127.0.0.1', port);
      assert.equal(await client.closeReason(73), VOLUNTARY);
      assert.equal(client.data(73).toString(), 'hello');
    } finally {
      server.close();
    }
  });

  test('keepalive: CONTINUE on stream 0 while a silent stream is open', async () => {
    const { server, port } = await tcpServer(() => {});
    client.connectTCP(72, '127.0.0.1', port);
    await sleep(500);
    const before = client.packets.length;
    await sleep(4000);
    const keepalives = client.packets
      .slice(before)
      .filter((p) => p.type === CONTINUE && p.streamId === 0);
    assert.ok(keepalives.length >= 1, `${keepalives.length} keepalives`);
    client.send(CLOSE, 72, Buffer.from([VOLUNTARY]));
    server.close();
  });
});

describe('policy', () => {
  test('SSRF: only public addresses and web ports by default', async () => {
    const stack = await startRelays([{ authorize: () => true }]);
    const client = await open(stack.url());
    try {
      let id = 1;
      // Ports 80/443, so only the address is checked. Nothing connects, no network needed.
      for (const host of [
        '127.0.0.1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '::1',
        '0.0.0.0',
        '10.0.0.1',
        '192.168.1.1',
        '172.17.0.1',
        '169.254.169.254',
        '100.64.0.1',
        'fd00::1',
        'fe80::1',
        '64:ff9b::7f00:1',
        'localhost',
      ]) {
        client.connectTCP(id, host, 443);
        assert.equal(await client.closeReason(id), BLOCKED, host);
        id++;
      }
      client.connectTCP(id, '1.1.1.1', 22);
      assert.equal(await client.closeReason(id), BLOCKED, 'port 22');
      client.connectTCP(++id, '', 0);
      assert.equal(await client.closeReason(id), INVALID, 'probe passes the port rule');
    } finally {
      await client.close();
      await stack.close();
    }
  });

  test('two relays with different policies in one process', async () => {
    const stack = await startRelays([
      { ...local, path: '/open/' },
      { path: '/strict/', authorize: () => true, policy: { ports: [echo.port] } },
    ]);
    const openClient = await open(stack.url('/open/'));
    const strict = await open(stack.url('/strict/'));
    try {
      openClient.connectTCP(1, '127.0.0.1', echo.port);
      openClient.send(DATA, 1, Buffer.from('ping'));
      await openClient.waitFor((p) => p.type === DATA && p.streamId === 1);
      assert.equal(openClient.data(1).toString(), 'ping');
      strict.connectTCP(1, '127.0.0.1', echo.port);
      assert.equal(await strict.closeReason(1), BLOCKED, 'loopback blocked on the strict relay');
      strict.connectTCP(2, '1.1.1.1', 443);
      assert.equal(await strict.closeReason(2), BLOCKED, 'port not in its list');
    } finally {
      await openClient.close();
      await strict.close();
      await stack.close();
    }
  });

  test('idleTimeoutMs closes silent streams', async () => {
    const stack = await startRelays([
      { ...local, policy: { ...local.policy, idleTimeoutMs: 300 } },
    ]);
    const { server, port } = await tcpServer(() => {});
    const client = await open(stack.url());
    try {
      client.connectTCP(1, '127.0.0.1', port);
      const started = Date.now();
      assert.equal(await client.closeReason(1, 3000), TIMEOUT);
      assert.ok(Date.now() - started >= 250);
    } finally {
      await client.close();
      await stack.close();
      server.close();
    }
  });
});

test('close() ends open connections and refuses new ones', async () => {
  const stack = await startRelays([local]);
  const client = await open(stack.url());
  client.connectTCP(1, '127.0.0.1', echo.port);
  await sleep(100);
  await stack.relays[0].close();
  assert.equal(await client.closed, 1001);
  assert.equal((await open(stack.url())).status, 503);
  await stack.close();
});
