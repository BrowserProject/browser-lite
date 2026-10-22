// Shared parts of the runners in the device container (run.mjs, start.mjs, frames.mjs): arguments,
// the forwarders to the sites of the server, configurations, readings of the device cgroup and of
// the Chromium profile.
import fs from 'node:fs';
import { connect, createServer } from 'node:net';
import path from 'node:path';

/** Value of `--<name>` on the command line or the fallback. */
export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

/**
 * One forwarder per site of the server (site n on port 8080 + n, see server.sh): the demo needs a
 * secure context (OPFS, Cache API), so it opens as localhost in the device and the forwarder sends
 * everything over the shaped link. A flag that treats the server address as secure is not enough
 * (navigator.storage stays missing). Each site has its own origin, so storage lock, OPFS, caches
 * and service workers of two engines never mix. Returns the origins, index = site.
 */
export async function forwardSites() {
  const upstream = new URL(process.env.SERVER);
  const count = Number(process.env.PERF_SITES || 1);
  const origins = [];
  for (let site = 0; site < count; site++) {
    const port = Number(upstream.port) + site;
    const forwarder = createServer((client) => {
      const server = connect(port, upstream.hostname);
      client.pipe(server).pipe(client);
      client.on('error', () => server.destroy());
      server.on('error', () => client.destroy());
    });
    await new Promise((resolve) => forwarder.listen(port, '127.0.0.1', resolve));
    origins.push(`http://localhost:${port}`);
  }
  return origins;
}

/**
 * Configurations of `--configs` (arms): name, site (index into the engines of the job, default 0),
 * params (into the URL of the demo) and engine (merged into the engine options of createBrowser,
 * for example {"env": {...}}). Unknown sites stop the run.
 */
export function readConfigs(origins) {
  const configs = JSON.parse(arg('configs', '[{"name":"A"}]'));
  for (const config of configs) {
    config.site ??= 0;
    config.params ??= {};
    config.engine ??= {};
    if (!origins[config.site]) throw new Error(`config ${config.name}: no site ${config.site}`);
  }
  return configs;
}

/** ABBA: every second run takes the arms in reverse order. */
export const armOrder = (configs, run) => (run % 2 === 0 ? configs : [...configs].reverse());

/** Sets window.blTestOptions (merged into the options of createBrowser by the demo). */
export async function testOptions(context, ca, engine) {
  const options = { engine: { ...(ca ? { extraCA: ca } : {}), ...engine } };
  await context.addInitScript((value) => {
    window.blTestOptions = value;
  }, options);
}

/**
 * Rejects when the demo reports an error at start (for example invalid options of a
 * configuration): such an arm can never be measured, so the run stops instead of waiting.
 */
export function startError(page) {
  const failed = new Promise((_, reject) =>
    page.on('console', (m) => {
      if (m.type() === 'error' && /BrowserLiteError|invalid-options/.test(m.text()))
        reject(new Error(`error at start: ${m.text()}`));
    }),
  );
  failed.catch(() => {});
  return failed;
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** CPU seconds of the device cgroup. */
export const cpuSeconds = () =>
  Number(/usage_usec (\d+)/.exec(readText('/sys/fs/cgroup/cpu.stat'))[1]) / 1e6;

/** Bytes received and sent by the device. */
export const netBytes = () => ({
  rx: Number(readText('/sys/class/net/eth0/statistics/rx_bytes')),
  tx: Number(readText('/sys/class/net/eth0/statistics/tx_bytes')),
});

/**
 * Memory of the device cgroup in MB: memMB is memory.current (with page cache), anonMB the
 * anonymous memory of memory.stat (without page cache, the part that counts for a device).
 */
export function memory() {
  const current = Number(readText('/sys/fs/cgroup/memory.current'));
  const anon = /^anon (\d+)$/m.exec(readText('/sys/fs/cgroup/memory.stat') ?? '');
  return {
    memMB: current ? Math.round(current / 1048576) : null,
    anonMB: anon ? Math.round(Number(anon[1]) / 1048576) : null,
  };
}

/**
 * memory.high of the device cgroup in MB, or null without a limit. device.sh sets it from the host
 * (`--mem-high <MB>` on the command line), the cgroup is read-only inside the container; with
 * `--mem-high` the runner checks that the limit is in place.
 */
export function memoryHigh() {
  const value = readText('/sys/fs/cgroup/memory.high')?.trim();
  const high = value && value !== 'max' ? Math.round(Number(value) / 1048576) : null;
  const wanted = arg('mem-high');
  if (wanted != null && high !== Number(wanted))
    throw new Error(`memory.high is ${high ?? 'max'} MB, --mem-high wants ${wanted} MB`);
  return high;
}

const dirSize = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .reduce(
          (s, e) =>
            s +
            (e.isDirectory()
              ? dirSize(path.join(dir, e.name))
              : fs.statSync(path.join(dir, e.name)).size),
          0,
        )
    : 0;

const wasmCodeCacheBytes = (profileDir) =>
  dirSize(path.join(profileDir, 'Default', 'Code Cache', 'wasm'));
const toMB = (bytes) => +(bytes / 1048576).toFixed(1);

/** Size of the WebAssembly code cache of V8 in a Chromium profile directory in MB. */
export const wasmCodeCacheMB = (profileDir) => toMB(wasmCodeCacheBytes(profileDir));

/**
 * Waits until the WebAssembly code cache of a Chromium profile directory has grown by at least
 * `growthMB` over `beforeMB` and then stayed unchanged for `quietMs`, and returns its size in MB.
 * V8 writes a module into it only once enough of its code is optimized (`wasm_caching_threshold`,
 * 1 MB) and after a pause (`wasm_caching_timeout_ms`, 2 s), so when depends on the speed of the
 * device. Throws after `timeoutMs`.
 */
export async function settledWasmCodeCacheMB(
  profileDir,
  beforeMB,
  { growthMB = 1, quietMs = 4000, timeoutMs = 120000 } = {},
) {
  const end = Date.now() + timeoutMs;
  let last = -1;
  let since = Date.now();
  for (;;) {
    const bytes = wasmCodeCacheBytes(profileDir);
    if (bytes !== last) {
      last = bytes;
      since = Date.now();
    } else if (toMB(bytes) >= beforeMB + growthMB && Date.now() - since >= quietMs) {
      return toMB(bytes);
    }
    if (Date.now() > end)
      throw new Error(
        `WebAssembly code cache at ${toMB(bytes)} MB after ${timeoutMs} ms, expected at least ${(beforeMB + growthMB).toFixed(1)} MB, unchanged for ${quietMs} ms`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Steps of the start in ms of performance.now() of the page (marks bl:<step> of the core: lock,
 * beforeStart, engine.js, engine.data, compile, instantiate, main, ready, prepared). Runs in the
 * page (page.evaluate).
 */
export const startMarks = () =>
  Object.fromEntries(
    performance
      .getEntriesByType('mark')
      .filter((mark) => mark.name.startsWith('bl:'))
      .map((mark) => [mark.name.slice(3), Math.round(mark.startTime)]),
  );
