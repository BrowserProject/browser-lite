// Connecting to a target with several addresses (Happy Eyeballs, RFC 8305): order of the
// families, an earlier slow attempt that still wins, failure reasons and aborting.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { connectSocket, interleaveFamilies } from '../dist/wisp/target.js';
import { closedPort, slowHandshakeServer } from './helpers.mjs';

const REFUSED = 0x44;
const v4 = (address) => ({ address, family: 4 });
const v6 = (address) => ({ address, family: 6 });

test('families alternate, starting with the first address', () => {
  const order = (list) => interleaveFamilies(list).map(({ address }) => address);
  assert.deepEqual(order([v4('a'), v4('b'), v6('x'), v6('y'), v6('z')]), ['a', 'x', 'b', 'y', 'z']);
  assert.deepEqual(order([v6('x'), v4('a'), v4('b')]), ['x', 'a', 'b']);
  assert.deepEqual(order([v4('a')]), ['a']);
});

test('a slow handshake still wins when the next address fails at once', async () => {
  const slow = await slowHandshakeServer(1000);
  // 127.0.0.2 refuses at once like an IPv6 address on a server without IPv6
  const start = Date.now();
  const socket = await connectSocket(
    slow.port,
    [v4('127.0.0.1'), v4('127.0.0.2')],
    new AbortController().signal,
  );
  assert.equal(socket.remoteAddress, '127.0.0.1');
  assert.ok(Date.now() - start > 250, 'the handshake was slow');
  socket.destroy();
  await slow.close();
});

test('a later address that connects first wins, after the attempt delay', async () => {
  const slow = await slowHandshakeServer(3000);
  const fast = net.createServer((socket) => socket.on('error', () => {}));
  await new Promise((resolve) => fast.listen(slow.port, '127.0.0.2', resolve));
  const start = Date.now();
  const socket = await connectSocket(
    slow.port,
    [v4('127.0.0.1'), v4('127.0.0.2')],
    new AbortController().signal,
  );
  const elapsed = Date.now() - start;
  assert.equal(socket.remoteAddress, '127.0.0.2');
  assert.ok(elapsed >= 240 && elapsed < 1000, `connected after ${elapsed} ms`);
  socket.destroy();
  fast.close();
  await slow.close();
});

test('every attempt failed: the reason of the last error', async () => {
  const port = await closedPort();
  await assert.rejects(
    connectSocket(port, [v4('127.0.0.1'), v4('127.0.0.2')], new AbortController().signal),
    (error) => error.reason === REFUSED,
  );
});

test('aborting destroys the attempts', async () => {
  const slow = await slowHandshakeServer(3000);
  const controller = new AbortController();
  const connecting = connectSocket(slow.port, [v4('127.0.0.1')], controller.signal);
  setTimeout(() => controller.abort(), 100);
  const start = Date.now();
  await assert.rejects(connecting);
  assert.ok(Date.now() - start < 1000);
  await assert.rejects(connectSocket(slow.port, [v4('127.0.0.1')], controller.signal));
  await slow.close();
});
