// Helper processes and temporary folders of a test: everything started here ends with the test
// process (also on SIGINT/SIGTERM), temporary folders are removed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { VERBOSE, root } from './env.mjs';

const children = new Set();
const tempDirs = new Set();
process.on('exit', () => {
  for (const child of children) child.kill();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.on(signal, () => process.exit(code));

/** New empty folder in the system temp folder, removed when the test ends. */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bl-${prefix}-`));
  tempDirs.add(dir);
  return dir;
}

/** A free TCP port on 127.0.0.1 (another process may still take it before it is used). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const serverScript = path.join(root, 'packages', 'server', 'dist', 'bin', 'browser-lite-server.js');

/** Waits until GET /healthz answers 200; fails when the process ends first or after ms. */
async function healthy(child, port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `browser-lite-server ended (${child.signalCode || child.exitCode}) before it was ready`,
      );
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`browser-lite-server not ready after ${ms / 1000} s`);
}

/**
 * Starts the browser-lite-server command (packages/server, built) with env on 127.0.0.1, ready when
 * /healthz answers. Without port a free one is taken, with a retry when another process took it in
 * between. Resolves { child, port }.
 */
export async function startServer(env, { port, ms = 30000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const use = port ?? (await freePort());
    const child = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        RELAY_TOKEN: '',
        RELAY_SECRET: '',
        ...env,
        PORT: String(use),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', VERBOSE ? 'inherit' : 'ignore', VERBOSE ? 'inherit' : 'ignore'],
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    try {
      await healthy(child, use, ms);
      return { child, port: use };
    } catch (error) {
      if (port !== undefined || attempt === 3) throw error;
    }
  }
}

/** Ends a child process and waits for its exit. */
export async function stopProcess(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
