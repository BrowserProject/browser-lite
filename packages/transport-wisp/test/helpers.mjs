// Shared helpers of the transport tests (not a test file itself).
import http from 'node:http';
import net from 'node:net';
import { createRelay } from '@browser-lite/server';
import { authorizeToken } from '@browser-lite/server/token';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const within = (promise, ms, fallback) =>
  Promise.race([promise, sleep(ms).then(() => fallback)]);

export async function waitUntil(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (condition()) return true;
  }
  return condition();
}

/**
 * The real relay of @browser-lite/server on 127.0.0.1, local targets allowed. `port` 0 picks a
 * free port; pass the previous port to restart on it.
 */
export async function startRelay({ port = 0, token, authorize } = {}) {
  const relay = createRelay({
    authorize: authorize ?? (token ? authorizeToken({ token }) : () => true),
    policy: { allowPrivateAddresses: true, ports: 'any' },
  });
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `ws://127.0.0.1:${actual}/wisp/`,
    async stop() {
      await relay.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** TCP proxy in front of a port; `cut()` drops all its connections like an idle timeout. */
export async function startProxy(targetPort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/wisp/`,
    connections: () => sockets.size / 2,
    cut() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      this.cut();
      server.close();
    },
  };
}

/** TCP server on 127.0.0.1:0. */
export async function tcpServer(onConnection, options = {}) {
  const server = net.createServer(options, onConnection);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** A port on 127.0.0.1 nothing listens on. */
export async function closedPort() {
  const { server, port } = await tcpServer(() => {});
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Sends `total` bytes over a stream to an echo server and waits for the answer. */
export async function echoOver(transport, echoPort, total, chunkSize = 16384) {
  const stream = transport.openTCP('127.0.0.1', echoPort);
  const chunk = new Uint8Array(Math.min(chunkSize, total)).map((_, i) => i & 0xff);
  let received = 0;
  let corrupt = false;
  const done = new Promise((resolve) => {
    stream.ondata = (data) => {
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== (((received + i) % chunk.length) & 0xff)) corrupt = true;
      }
      received += data.length;
      if (received >= total) resolve();
    };
    stream.onclose = resolve;
  });
  stream.onopen = () => {
    for (let sent = 0; sent < total; sent += chunk.length) stream.send(chunk.slice());
  };
  await within(done, 20000);
  stream.close();
  return { received, corrupt };
}

/** A stream that answered an echo (really connected), else null. */
export async function echoStream(transport, host, port) {
  const stream = transport.openTCP(host, port);
  const answered = await within(
    new Promise((resolve) => {
      stream.ondata = () => resolve(true);
      stream.onclose = () => resolve(false);
      stream.onopen = () => stream.send(new Uint8Array([1]));
    }),
    5000,
    false,
  );
  return answered ? stream : null;
}

/** Close reason of a stream to host:port, null if it stays open; `opened` tells if onopen ran. */
export async function closeReason(transport, host, port, ms = 5000) {
  const stream = transport.openTCP(host, port);
  let opened = false;
  stream.onopen = () => {
    opened = true;
  };
  const reason = await within(
    new Promise((resolve) => {
      stream.onclose = resolve;
    }),
    ms,
    null,
  );
  if (reason === null) stream.close();
  return { reason, opened };
}

/** Records `connectedchange` events as a list of booleans. */
export function connectionLog(transport) {
  const states = [];
  transport.addEventListener('connectedchange', () => states.push(transport.connected));
  return states;
}
