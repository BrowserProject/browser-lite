// Shared helpers of the server tests (not a test file itself).
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../dist/index.js';

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const bin = path.join(packageDir, 'dist', 'bin', 'browser-lite-server.js');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const within = (promise, ms, fallback) =>
  Promise.race([promise, sleep(ms).then(() => fallback)]);

export async function waitUntil(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await condition()) return true;
  }
  return condition();
}

/** HTTP server on 127.0.0.1 with one or more relays; returns { url(path), relays, close }. */
export async function startRelays(configs) {
  const relays = configs.map((options) => createRelay(options));
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!relays.some((relay) => relay.handleUpgrade(req, socket, head))) socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    relays,
    url: (urlPath = '/wisp/') => `ws://127.0.0.1:${port}${urlPath}`,
    async close() {
      await Promise.all(relays.map((relay) => relay.close()));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** TCP server on 127.0.0.1:0; resolves with { server, port }. */
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

/** True if this machine fails fast to reach 2001:db8::1 (documentation prefix, no route). */
export function documentationPrefixUnreachable() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '2001:db8::1', port: 80 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.on('error', (error) => done(['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)));
    socket.on('connect', () => done(false));
    setTimeout(() => done(false), 3000).unref();
  });
}

export function request(port, urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers, agent: false },
      (res) => {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Raw request: the answer as text, and whether the server closed the connection. */
export function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let answer = '';
    socket.on('data', (d) => {
      answer += d;
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ answer, closed: true }));
    setTimeout(() => {
      socket.destroy();
      resolve({ answer, closed: false });
    }, 3000);
  });
}

const children = new Set();
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

/**
 * Starts the CLI on a free port. Resolves { child, port, log, exited } once it listens, or
 * { child, ready: false, code } if it ends before.
 */
export async function startCli(env = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bin], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      RELAY_TOKEN: '',
      RELAY_SECRET: '',
      RELAY_ALLOW_LOCAL: '',
      RELAY_ALLOWED_ORIGINS: '',
      RELAY_TRUST_PROXY: '',
      SITE_DIR: '',
      PROFILE_DIR: '',
      PROFILE_MAX_MB: '',
      ALLOWED_HOSTS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const state = { child, log: '', ready: false, port: 0 };
  child.stderr.on('data', (d) => {
    state.log += d;
  });
  state.exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const match = /listening on [^\s]+:(\d+)/.exec(out);
      if (match && !state.ready) {
        state.ready = true;
        state.port = Number(match[1]);
        resolve();
      }
    });
    state.exited.then(resolve);
  });
  if (!state.ready) state.code = (await state.exited).code;
  return state;
}

/** SIGTERM; resolves with the exit, or { code: 'hangs' } after 3 s. */
export function stopCli(state) {
  state.child.kill('SIGTERM');
  return within(state.exited, 3000, { code: 'hangs' });
}
