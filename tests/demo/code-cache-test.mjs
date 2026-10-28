// The demo again after Chromium restarted (same profile): V8 takes the compiled engine from
// Chromium's code cache instead of compiling the hot engine code again (seconds of CPU on a weak
// device). A preload link for engine.wasm, for example, makes Chromium skip the cache (#237).
//
//   node tests/demo/code-cache-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  TIMEOUT,
  check,
  chromiumOnly,
  finish,
  launchProfile,
  startStack,
  tempDir,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(3 * TIMEOUT);
// The cache hit is a V8 trace event, read through CDP
if (!chromiumOnly('code cache (V8 trace events through CDP)')) finish();

const stack = await startStack({ app: 'demo' });
const profile = tempDir('chromium-profile');
const wasmCache = path.join(profile, 'Default', 'Code Cache', 'wasm');
const cachedBytes = () =>
  fs.existsSync(wasmCache)
    ? fs.readdirSync(wasmCache).reduce((sum, name) => {
        const stats = fs.statSync(path.join(wasmCache, name));
        return sum + (stats.isFile() ? stats.size : 0);
      }, 0)
    : 0;

/** Starts Chromium with the profile and the demo; resolves with the names of the trace events. */
async function start(whileRunning) {
  const context = await launchProfile({ dir: profile, viewport: { width: 1000, height: 700 } });
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (data) => events.push(...data.value));
  // The code cache events of Blink (v8.wasm.moduleCacheHit, v8.wasm.cachedModule)
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] },
    transferMode: 'ReportEvents',
  });
  await page.goto(stack.app());
  await page.waitForFunction(() => window.blTest?.browser?.ready, null, { timeout: TIMEOUT });
  await whileRunning();
  const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  await complete;
  await context.close();
  return new Set(events.map((event) => event.name));
}

// V8 writes the cache once enough engine code is optimized, a few seconds after the start
await start(() => waitFor(() => cachedBytes() > 1e6, 90000, 500));
check('the first start leaves compiled engine code', cachedBytes() > 1e6, `${cachedBytes()} bytes`);

const second = await start(async () => {});
check(
  'the second start takes the engine from the code cache',
  second.has('v8.wasm.moduleCacheHit'),
  [...second].filter((name) => name.startsWith('v8.wasm')).join(',') || 'no wasm cache events',
);

finish();
