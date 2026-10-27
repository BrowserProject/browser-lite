// WispTransport against the real relay of @browser-lite/server: token, echo with flow control,
// backpressure (onsent), close reasons, limits per target, dual stack, closing semantics,
// reconnect after a relay restart and after a dropped WebSocket, connection state, close(),
// a token refused after the upgrade.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { authorizeToken } from '@browser-lite/server/token';
import { WispTransport } from '../dist/index.js';
import {
  closedPort,
  closeReason,
  connectionLog,
  echoOver,
  echoStream,
  sleep,
  startProxy,
  startRelay,
  tcpServer,
  waitUntil,
  within,
} from './helpers.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const STREAMS_PER_HOST = 64;

let echo;
before(async () => {
  echo = await tcpServer((socket) => socket.pipe(socket));
});
after(() => echo.server.close());

test('constructor needs a url', () => {
  assert.throws(() => new WispTransport({}), TypeError);
  assert.throws(() => new WispTransport(), TypeError);
  assert.throws(
    () => new WispTransport({ connections: 1, url: 'ftp://127.0.0.1:1/wisp/' }),
    TypeError,
  );
  // Relative without a location to resolve against
  assert.throws(() => new WispTransport({ connections: 1, url: '/wisp/' }), TypeError);
});

test('relative and http URLs resolve against location', async () => {
  const relay = await startRelay();
  const RealWebSocket = globalThis.WebSocket;
  const urls = [];
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url) {
      urls.push(url);
      super(url);
    }
  };
  globalThis.location = { href: `http://127.0.0.1:${relay.port}/demo/index.html` };
  const transport = new WispTransport({ connections: 1, url: '/wisp/' });
  delete globalThis.location;
  globalThis.WebSocket = RealWebSocket;
  try {
    assert.equal((await echoOver(transport, echo.port, 1000)).received, 1000);
    assert.deepEqual(urls, [`ws://127.0.0.1:${relay.port}/wisp/`]);
  } finally {
    transport.close();
    await relay.stop();
  }
});

test('preconnect opens the WebSocket before the first stream, which then uses it', async () => {
  const relay = await startRelay();
  const proxy = await startProxy(relay.port);
  const transport = new WispTransport({ connections: 1, url: proxy.url });
  try {
    transport.preconnect();
    assert.ok(await waitUntil(() => proxy.connections() === 1, 2000), 'connected without a stream');
    assert.equal((await echoOver(transport, echo.port, 1000)).received, 1000);
    assert.equal(proxy.connections(), 1, 'one WebSocket');
  } finally {
    transport.close();
    proxy.close();
    await relay.stop();
  }
});

test('acknowledges what it received: at once after the handshake, then while data arrives', async () => {
  const relay = await startRelay();
  const RealWebSocket = globalThis.WebSocket;
  const acks = [];
  let received = 0;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (event) => {
        received += event.data.byteLength ?? event.data.size;
      });
    }
    send(data) {
      const bytes = new Uint8Array(data);
      if (bytes[0] === 0x03 && new DataView(bytes.buffer).getUint32(1, true) === 0)
        acks.push(new DataView(bytes.buffer).getUint32(5, true));
      super.send(data);
    }
  };
  const transport = new WispTransport({
    connections: 1,
    url: `ws://127.0.0.1:${relay.port}/wisp/`,
  });
  globalThis.WebSocket = RealWebSocket;
  try {
    assert.equal((await echoOver(transport, echo.port, 16384 * 12)).received, 16384 * 12);
    assert.equal(acks[0], 9, 'the first CONTINUE of the relay');
    assert.ok(
      await waitUntil(() => acks.at(-1) === received, 1000),
      `${acks.at(-1)} of ${received}`,
    );
  } finally {
    transport.close();
    await relay.stop();
  }
});

test('connections: 1 to 8 WebSockets', () => {
  for (const connections of [0, 9, 1.5, '2'])
    assert.throws(
      () => new WispTransport({ url: 'ws://127.0.0.1:1/wisp/', connections }),
      TypeError,
    );
});

test('several WebSockets: preconnect opens all, streams go to the least busy one', async () => {
  const relay = await startRelay();
  const proxy = await startProxy(relay.port);
  const transport = new WispTransport({ url: proxy.url, connections: 3 });
  try {
    transport.preconnect();
    assert.ok(await waitUntil(() => proxy.connections() === 3, 2000), 'three WebSockets');
    const streams = await Promise.all(
      Array.from({ length: 6 }, () => echoStream(transport, '127.0.0.1', echo.port)),
    );
    assert.ok(streams.every(Boolean), 'every stream echoes');
    assert.equal(proxy.connections(), 3, 'no further WebSockets');
    assert.equal((await echoOver(transport, echo.port, 98304)).received, 98304);
    for (const stream of streams) stream.close();
  } finally {
    transport.close();
    proxy.close();
    await relay.stop();
  }
});

test('a throwing WebSocket constructor goes offline and reconnects', async () => {
  const relay = await startRelay();
  const RealWebSocket = globalThis.WebSocket;
  let attempts = 0;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url) {
      if (++attempts === 1) throw new SyntaxError('refused');
      super(url);
    }
  };
  const transport = new WispTransport({ connections: 1, url: relay.url });
  globalThis.WebSocket = RealWebSocket;
  try {
    const states = connectionLog(transport);
    const first = await closeReason(transport, '127.0.0.1', echo.port);
    assert.deepEqual(first, { reason: 'transport-down', opened: false });
    assert.equal(transport.connected, false);
    assert.ok(await waitUntil(() => transport.connected, 5000), 'reconnected');
    assert.deepEqual(states, [false, true]);
    assert.equal(attempts, 2);
    assert.equal((await echoOver(transport, echo.port, 1000)).received, 1000);
  } finally {
    transport.close();
    await relay.stop();
  }
});

test('a relay refusing the token after the upgrade: error event, slower retries, new token', async () => {
  // Completes the WebSocket upgrade (selecting the subprotocol wisp, as the client offers one) and
  // closes at once with 4401, like a relay that checks the token after the upgrade
  const server = http.createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: wisp\r\n\r\n`,
    );
    socket.end(Buffer.from([0x88, 0x02, 0x11, 0x31]));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tokens = [];
  const transport = new WispTransport({
    connections: 1,
    url: `ws://127.0.0.1:${server.address().port}/wisp/`,
    token: () => {
      tokens.push(Date.now());
      return `token-${tokens.length}`;
    },
  });
  const errors = [];
  transport.addEventListener('error', (event) => errors.push(event.reason));
  try {
    const result = await closeReason(transport, '127.0.0.1', echo.port);
    assert.deepEqual(result, { reason: 'transport-down', opened: false });
    assert.ok(await waitUntil(() => errors.length === 1, 2000), 'error event');
    assert.deepEqual(errors, ['unauthorized']);
    assert.equal(transport.connected, false);
    // The first retry waits 4 s instead of 2 s and fetches the token again
    assert.ok(await waitUntil(() => tokens.length === 2, 7000), 'retried');
    assert.ok(tokens[1] - tokens[0] >= 3500, `retry after ${tokens[1] - tokens[0]} ms`);
    assert.ok(await waitUntil(() => errors.length === 2, 2000), 'second error event');
  } finally {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('with token', () => {
  let relay;
  let transport;
  before(async () => {
    relay = await startRelay({ token: TOKEN });
    transport = new WispTransport({ connections: 1, url: relay.url, token: TOKEN });
  });
  after(async () => {
    transport.close();
    await relay.stop();
  });

  test('wrong and missing token: stream ends before onopen with transport-down', async () => {
    for (const options of [{ token: 'wrong-token-0123456789' }, {}]) {
      const bad = new WispTransport({ connections: 1, url: relay.url, ...options });
      const states = connectionLog(bad);
      const result = await closeReason(bad, '127.0.0.1', echo.port);
      assert.deepEqual(result, { reason: 'transport-down', opened: false });
      assert.equal(bad.connected, false);
      assert.deepEqual(states, [false]);
      bad.close();
    }
  });

  test('token as subprotocol, never in the URL, any characters', async () => {
    const special = 'static/token+with=chars ä';
    const seen = [];
    const own = await startRelay({
      authorize: (req) => {
        seen.push({ url: req.url, protocol: req.headers['sec-websocket-protocol'] });
        return authorizeToken({ token: special })(req);
      },
    });
    const client = new WispTransport({ connections: 1, url: own.url, token: special });
    const result = await echoOver(client, echo.port, 1000);
    assert.equal(result.received, 1000);
    assert.equal(seen[0].url, '/wisp/');
    assert.match(seen[0].protocol, /^wisp, bl-token\.[\w-]+$/);
    client.close();
    await own.stop();
  });

  test('token getter, also async, called per connect', async () => {
    let calls = 0;
    const getter = new WispTransport({
      connections: 1,
      url: new URL(relay.url),
      token: async () => {
        calls++;
        await sleep(5);
        return TOKEN;
      },
    });
    const result = await echoOver(getter, echo.port, 1000);
    assert.equal(result.received, 1000);
    assert.equal(calls, 1);
    const failing = new WispTransport({
      connections: 1,
      url: relay.url,
      token: () => {
        throw new Error('no token');
      },
    });
    assert.equal((await closeReason(failing, '127.0.0.1', echo.port)).reason, 'transport-down');
    failing.close();
    getter.close();
  });

  test('2 MB echo, and large writes split into packets', async () => {
    const big = await echoOver(transport, echo.port, 2 * 1024 * 1024);
    assert.equal(big.received, 2 * 1024 * 1024);
    assert.equal(big.corrupt, false);
    const single = await echoOver(transport, echo.port, 300 * 1024, 300 * 1024);
    assert.equal(single.received, 300 * 1024);
    assert.equal(single.corrupt, false);
  });

  test('close reasons of failed streams', async () => {
    assert.equal((await closeReason(transport, '127.0.0.1', await closedPort())).reason, 'refused');
    assert.equal(
      (await closeReason(transport, 'nonexistent.invalid', 80)).reason,
      'name-not-resolved',
    );
    const probe = await closeReason(transport, '', 0);
    assert.deepEqual(probe, { reason: 'invalid', opened: true });
  });

  test('address without route: unreachable', async (t) => {
    const unreachable = await new Promise((resolve) => {
      const socket = net.connect({ host: '2001:db8::1', port: 80 });
      const done = (result) => {
        socket.destroy();
        resolve(result);
      };
      socket.on('error', (error) => done(['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)));
      socket.on('connect', () => done(false));
      setTimeout(() => done(false), 3000).unref();
    });
    if (!unreachable) {
      t.skip('2001:db8::1 is not unreachable at once on this machine');
      return;
    }
    assert.equal((await closeReason(transport, '2001:db8::1', 80)).reason, 'unreachable');
  });

  test('streams closed right after CONNECT never connect', async () => {
    let accepted = 0;
    const { server, port } = await tcpServer((socket) => {
      accepted++;
      socket.destroy();
    });
    for (let i = 0; i < 20; i++) {
      const stream = transport.openTCP('localhost', port);
      stream.onopen = () => stream.close();
    }
    await sleep(1500);
    assert.equal(accepted, 0);
    server.close();
  });

  test('limit per target (name and port)', async () => {
    const held = await Promise.all(
      Array.from({ length: STREAMS_PER_HOST }, () => echoStream(transport, '127.0.0.1', echo.port)),
    );
    try {
      assert.ok(held.every(Boolean), `${held.filter(Boolean).length} connected`);
      assert.equal((await closeReason(transport, '127.0.0.1', echo.port)).reason, 'throttled');
      assert.equal((await closeReason(transport, '127.0.0.1.', echo.port)).reason, 'throttled');
      assert.equal(
        (await closeReason(transport, '127.0.0.1', await closedPort())).reason,
        'refused',
      );
      // "127.1" is another name that getaddrinfo also resolves to 127.0.0.1
      const other = await echoStream(transport, '127.1', echo.port);
      assert.ok(other);
      other.close();
      held.pop()?.close();
      const freed = await echoStream(transport, '127.0.0.1', echo.port);
      assert.ok(freed, 'a closed stream frees its place');
      freed.close();
    } finally {
      for (const stream of held) stream?.close();
    }
  });

  test('name with IPv6 first, target only on IPv4', async () => {
    const stream = await echoStream(transport, 'localhost', echo.port);
    assert.ok(stream);
    stream.close();
  });

  test('backpressure: onsent stalls while the target does not read', async () => {
    let paused = null;
    const { server, port } = await tcpServer((socket) => {
      paused = socket;
      socket.pause();
    });
    const total = 64 * 1024 * 1024;
    const stream = transport.openTCP('127.0.0.1', port);
    let sent = 0;
    stream.onsent = (bytes) => {
      sent += bytes;
    };
    stream.onopen = () => {
      const chunk = new Uint8Array(65536);
      for (let queued = 0; queued < total; queued += chunk.length) stream.send(chunk);
    };
    await sleep(3000);
    const stalled = sent;
    paused?.resume();
    paused?.on('data', () => {});
    await waitUntil(() => sent >= total, 30000);
    stream.close();
    server.close();
    assert.ok(stalled > 0 && stalled < total, `${stalled} of ${total} bytes`);
    assert.equal(sent, total);
  });

  test('a closed stream closes the socket to a target that keeps sending', async () => {
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
    const stream = transport.openTCP('127.0.0.1', port);
    await within(
      new Promise((resolve) => {
        stream.ondata = resolve;
      }),
      5000,
    );
    stream.close();
    assert.ok(await waitUntil(() => targetClosed, 3000));
    server.close();
  });

  test('target closing: reason closed after the data', async () => {
    const { server, port } = await tcpServer((socket) => socket.end('bye'));
    const stream = transport.openTCP('127.0.0.1', port);
    let text = '';
    stream.ondata = (data) => {
      text += Buffer.from(data).toString();
    };
    const reason = await new Promise((resolve) => {
      stream.onclose = resolve;
    });
    assert.equal(reason, 'closed');
    assert.equal(text, 'bye');
    server.close();
  });
});

describe('reconnect', () => {
  test('same transport works after a relay restart, state goes down and up by itself', async () => {
    let relay = await startRelay({ token: TOKEN });
    let tokens = 0;
    const transport = new WispTransport({
      connections: 1,
      url: relay.url,
      token: () => {
        tokens++;
        return TOKEN;
      },
    });
    try {
      assert.equal((await echoOver(transport, echo.port, 64 * 1024)).received, 64 * 1024);
      const states = connectionLog(transport);
      await relay.stop();
      assert.ok(await waitUntil(() => !transport.connected, 3000), 'offline after the stop');
      relay = await startRelay({ port: relay.port, token: TOKEN });
      // No new stream needed: the transport reconnects by itself, without any listener
      assert.ok(await waitUntil(() => transport.connected, 8000), 'online again');
      assert.deepEqual(states, [false, true]);
      assert.ok(tokens >= 2, `token asked ${tokens} times`);
      const again = await echoOver(transport, echo.port, 64 * 1024);
      assert.equal(again.received, 64 * 1024);
      assert.equal(again.corrupt, false);
    } finally {
      transport.close();
      await relay.stop();
    }
  });

  test('WebSocket dropped (proxy idle timeout), relay alive: reconnected, never offline', async () => {
    const relay = await startRelay();
    const proxy = await startProxy(relay.port);
    const transport = new WispTransport({ connections: 1, url: proxy.url });
    try {
      assert.equal((await echoOver(transport, echo.port, 1000)).received, 1000);
      const states = connectionLog(transport);
      const open = transport.openTCP('127.0.0.1', echo.port);
      const reason = new Promise((resolve) => {
        open.onclose = resolve;
      });
      await sleep(100);
      proxy.cut();
      assert.equal(await reason, 'transport-down', 'open streams end');
      assert.ok(await waitUntil(() => proxy.connections() === 1, 3000), 'new connection');
      assert.equal(transport.connected, true);
      assert.deepEqual(states, []);
      assert.equal((await echoOver(transport, echo.port, 1000)).received, 1000);
    } finally {
      transport.close();
      proxy.close();
      await relay.stop();
    }
  });

  test('close() ends streams and stops reconnecting', async () => {
    const relay = await startRelay();
    const proxy = await startProxy(relay.port);
    const transport = new WispTransport({ connections: 1, url: proxy.url });
    try {
      const stream = await echoStream(transport, '127.0.0.1', echo.port);
      assert.ok(stream);
      const reason = new Promise((resolve) => {
        stream.onclose = resolve;
      });
      const states = connectionLog(transport);
      transport.close();
      assert.equal(await reason, 'transport-down');
      assert.deepEqual(states, [false]);
      await sleep(2500);
      assert.equal(proxy.connections(), 0, 'no reconnect after close()');
      const late = await closeReason(transport, '127.0.0.1', echo.port, 1000);
      assert.deepEqual(late, { reason: 'transport-down', opened: false });
    } finally {
      proxy.close();
      await relay.stop();
    }
  });
});
