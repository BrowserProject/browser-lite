// Start of the engine: per run and arm a new Chromium profile with three starts in a row (1, visit
// cold: nothing cached, 2 and 3, visit warm: engine in the HTTP cache and the code cache of V8).
// Measured: when the browser of the demo is ready, the first layout of example.com, the download
// of engine.wasm, the size of the WebAssembly code cache of Chromium in the profile, the steps of
// the start (marks bl:<step> of the core: lock, beforeStart, engine.js, engine.data, compile,
// instantiate, main, ready, prepared) and the times of the engine (main(), every pthread_create
// before ready, compositor ready, ready; from debug.measurements()), all in ms of
// performance.now() of the page. Arms take turns per run (ABBA), configurations as in run.mjs
// (measure.mjs readConfigs).
//   node start.mjs --out <jsonl> --runs n --ca <pem> [--label x] [--configs '<json>']
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  arg,
  armOrder,
  cpuSeconds,
  forwardSites,
  memory,
  netBytes,
  readConfigs,
  startError,
  testOptions,
} from './measure.mjs';

const out = arg('out');
const runs = Number(arg('runs', 3));
const label = arg('label', '');
const ca = fs.readFileSync(arg('ca'), 'utf8');
const origins = await forwardSites();
const configs = readConfigs(origins);

const HOOKS = () => {
  const t = (window.__perf = {});
  const timer = setInterval(() => {
    const test = window.blTest;
    if (test?.browser && t.ready == null) t.ready = performance.now();
    if (test?.flags?.firstLayout && t.firstLayout == null) {
      t.firstLayout = performance.now();
      clearInterval(timer);
    }
  }, 20);
};
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

async function start(dir, config) {
  const context = await chromium.launchPersistentContext(dir, {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(HOOKS);
  await testOptions(context, ca, config.engine);
  const page = context.pages()[0] || (await context.newPage());
  const failed = startError(page);
  const cpu0 = cpuSeconds();
  const rx0 = netBytes().rx;
  const t0 = Date.now();
  const query = new URLSearchParams({ url: 'https://example.com/', debug: '1', ...config.params });
  await page.goto(`${origins[config.site]}/?${query}`);
  let status = 'ok';
  const layout = page.waitForFunction(() => window.__perf?.firstLayout != null, null, {
    timeout: 300000,
    polling: 100,
  });
  await Promise.race([layout, failed]).catch((error) => {
    if (/error at start/.test(error.message)) throw new Error(`${config.name}: ${error.message}`);
    status = 'timeout';
  });
  const wall = Date.now() - t0;
  const cpu = cpuSeconds() - cpu0;
  const rx = netBytes().rx - rx0;
  const info = await page.evaluate(() => ({
    perf: window.__perf,
    wasm: performance
      .getEntriesByType('resource')
      .filter((r) => /engine\.wasm/.test(r.name))
      .map((r) => ({
        start: r.startTime,
        end: r.responseEnd,
        duration: Math.round(r.duration),
        size: r.transferSize,
      }))[0],
    marks: Object.fromEntries(
      performance
        .getEntriesByType('mark')
        .filter((mark) => mark.name.startsWith('bl:'))
        .map((mark) => [mark.name.slice(3), mark.startTime]),
    ),
    engine: (() => {
      try {
        return window.blTest.measurements();
      } catch {
        return null;
      }
    })(),
  }));
  const mem = memory();
  // Chromium writes the code cache with a delay
  await page.waitForTimeout(5000);
  await context.close();
  const p = info.perf || {};
  const round = (value) => (value != null ? Math.round(value) : null);
  const marks = info.marks || {};
  const engine = info.engine || {};
  return {
    status,
    t0,
    wall,
    cpu: +cpu.toFixed(2),
    ready: round(p.ready),
    firstLayout: round(p.firstLayout),
    layoutAfterReady: p.firstLayout != null ? round(p.firstLayout - p.ready) : null,
    wasmDuration: info.wasm?.duration,
    wasmSize: info.wasm?.size,
    wasmStart: round(info.wasm?.start),
    wasmEnd: round(info.wasm?.end),
    markLock: round(marks.lock),
    markBeforeStart: round(marks.beforeStart),
    markEngineJs: round(marks['engine.js']),
    markEngineData: round(marks['engine.data']),
    markCompile: round(marks.compile),
    markInstantiate: round(marks.instantiate),
    markMain: round(marks.main),
    markReady: round(marks.ready),
    markPrepared: round(marks.prepared),
    engineMain: round(engine.main),
    engineCompositorReady: round(engine.compositorReady),
    engineReady: round(engine.ready),
    engineThreads: engine.threadsBeforeReady ?? null,
    engineThreadTimes: engine.threadTimes?.map(round) ?? null,
    rx,
    ...mem,
  };
}

for (let run = 0; run < runs; run++) {
  for (const config of armOrder(configs, run)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-start-'));
    for (let n = 1; n <= 3; n++) {
      const r = await start(dir, config);
      const row = {
        kind: 'start',
        label,
        profile: process.env.PERF_PROFILE,
        net: process.env.PERF_NET,
        site: 'example',
        config: config.name,
        engineSite: config.site,
        run,
        start: n,
        visit: n === 1 ? 'cold' : 'warm',
        ...r,
        wasmCodeCacheMB: +(
          dirSize(path.join(dir, 'Default', 'Code Cache', 'wasm')) / 1048576
        ).toFixed(1),
      };
      fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(
        `${row.profile} ${row.net} ${config.name} #${run} start ${n}: ${r.status} ready ${r.ready} ms, layout ${r.firstLayout} ms, wasm ${r.wasmDuration} ms ${r.wasmSize} B, code cache ${row.wasmCodeCacheMB} MB`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(0);
