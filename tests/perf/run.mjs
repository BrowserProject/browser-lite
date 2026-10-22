// Measurement run in the device container: loads sites in the demo and writes one JSON line per
// load. Configurations (arms) take turns per run (ABBA).
//
//   node run.mjs --out <jsonl> --runs <n> --visit cold|warm --sites wiki,cnn,...
//                [--configs '<json>'] [--ca <pem>] [--timeout <s>] [--label <text>]
//                [--logs <dir>] [--linger <ms>] [--mem-high <MB>]
//
// configs: [{"name":"E0","site":0},{"name":"E1","site":1,"params":{"log":"1"},
// "engine":{"env":{...}}}, ...] (measure.mjs readConfigs): site selects the engine of the job,
// params go into the URL of the demo, engine into the engine options.
// cold: a new browser profile from the template (engines of the sites of the arms in the HTTP and
// code cache of Chromium, browser-lite itself empty). warm: then the browser restarts and loads the same
// site again (HTTP cache, service workers). Times are milliseconds after the
// browser of the demo is ready. --mem-high: memory.high of the device in MB (set by device.sh).
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
  memoryHigh,
  netBytes,
  readConfigs,
  settledWasmCodeCacheMB,
  startError,
  startMarks,
  testOptions,
  wasmCodeCacheMB,
} from './measure.mjs';

const SITES = {
  example: 'https://example.com/',
  wiki: 'https://de.wikipedia.org/wiki/Schweiz',
  cnn: 'https://edition.cnn.com/',
  min20: 'https://www.20min.ch/',
  weather: 'https://weather.com/',
  youtube: 'https://www.youtube.com/',
  github: 'https://github.com/WebKit/WebKit',
};

const out = arg('out');
const runs = Number(arg('runs', 3));
const visit = arg('visit', 'cold');
const label = arg('label', '');
const sites = arg('sites', 'example').split(',');
const caFile = arg('ca');
const ca = caFile ? fs.readFileSync(caFile, 'utf8') : null;
const TIMEOUT = Number(arg('timeout', 400)) * 1000;
const logDir = arg('logs');
const linger = Number(arg('linger', 0));
const net = process.env.PERF_NET || '?';
const profile = process.env.PERF_PROFILE || '?';
const memHigh = memoryHigh();

const origins = await forwardSites();
const configs = readConfigs(origins);
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const TEMPLATE = path.join(os.tmpdir(), 'bl-perf-template');

// window.blTest.flags of the demo (?debug=1) have no times: poll them every 20 ms
const HOOKS = () => {
  const t = (window.__perf = {});
  const timer = setInterval(() => {
    const test = window.blTest;
    if (!test) return;
    if (test.browser && t.ready == null) t.ready = performance.now();
    for (const flag of ['firstLayout', 'firstPaint', 'loaded'])
      if (test.flags?.[flag] && t[flag] == null) t[flag] = performance.now();
    if (t.loaded != null && t.firstPaint != null) clearInterval(timer);
  }, 20);
};

async function launch(dir, engine) {
  const context = await chromium.launchPersistentContext(dir, {
    args: ARGS,
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(HOOKS);
  await testOptions(context, ca, engine);
  return context;
}

// The template profile has the engine of every site of the arms in the HTTP and code cache of
// Chromium. Every site waits until its engine is in the code cache (the job fails otherwise), so
// that every arm starts from the same state.
async function makeTemplate() {
  if (fs.existsSync(TEMPLATE)) return;
  const context = await launch(TEMPLATE, {});
  const page = context.pages()[0] || (await context.newPage());
  const sizes = [];
  for (const site of new Set(configs.map((config) => config.site))) {
    const before = wasmCodeCacheMB(TEMPLATE);
    await page.goto(`${origins[site]}/?debug=1&url=about:blank`);
    await page.waitForFunction(() => window.__perf?.ready, null, { timeout: 300000 });
    const size = await settledWasmCodeCacheMB(TEMPLATE, before).catch((error) => {
      throw new Error(`template, site ${site}: ${error.message}`);
    });
    sizes.push(`site ${site} ${size} MB`);
  }
  await context.close();
  console.log(
    `template wasm code cache: ${sizes.join(', ')}, closed ${wasmCodeCacheMB(TEMPLATE)} MB`,
  );
}

async function measure(dir, site, config, stay) {
  const context = await launch(dir, config.engine);
  const page = context.pages()[0] || (await context.newPage());
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message}`));
  const failed = startError(page);
  const cpu0 = cpuSeconds();
  const net0 = netBytes();
  const t0 = Date.now();
  const query = new URLSearchParams({ url: SITES[site] || site, debug: '1', ...config.params });
  await page.goto(`${origins[config.site]}/?${query}`);
  let status = 'ok';
  try {
    const ready = page.waitForFunction(() => window.__perf?.ready != null, null, {
      timeout: TIMEOUT,
      polling: 100,
    });
    await Promise.race([ready, failed]);
    await page.waitForFunction(() => window.__perf?.loaded != null, null, {
      timeout: Math.max(1000, TIMEOUT - (Date.now() - t0)),
      polling: 100,
    });
  } catch (error) {
    if (/error at start/.test(error.message)) throw new Error(`${config.name}: ${error.message}`);
    status = 'timeout';
  }
  // First layout and paint sometimes come after load (GitHub)
  await page
    .waitForFunction(
      () => window.__perf?.firstLayout != null && window.__perf?.firstPaint != null,
      null,
      { timeout: 20000, polling: 100 },
    )
    .catch(() => {});
  // Before the second visit stay like a user (the HTTP cache stores asynchronously)
  if (linger || stay) await page.waitForTimeout(Math.max(linger, stay));
  const cpu = cpuSeconds() - cpu0;
  const net1 = netBytes();
  // The span of the cpu and rx readings, which the filter for foreign load checks (stats.mjs)
  const wall = Date.now() - t0;
  const marks = await page.evaluate(startMarks).catch(() => ({}));
  const info = await page
    .evaluate(() => ({
      perf: window.__perf,
      title: document.title,
      crashed: window.blTest?.browser?.state === 'crashed',
      // Size of the WebAssembly memory (the engine reads it, a view of the page may be stale)
      wasm: (() => {
        try {
          return window.blTest.measurements()?.memoryBytes;
        } catch {
          return null;
        }
      })(),
    }))
    .catch((e) => ({ error: e.message }));
  const mem = memory();
  if (logDir)
    fs.writeFileSync(
      path.join(logDir, `${profile}-${net}-${site}-${config.name}-${t0}.log`),
      logs.join('\n'),
    );
  await context.close();
  const p = info.perf || {};
  const after = (key) => (p[key] != null && p.ready != null ? Math.round(p[key] - p.ready) : null);
  if (info.crashed) status = 'crashed';
  return {
    status,
    t0,
    wall,
    cpu: +cpu.toFixed(2),
    ready: p.ready != null ? Math.round(p.ready) : null,
    firstLayout: after('firstLayout'),
    markCompile: marks.compile ?? null,
    markInstantiate: marks.instantiate ?? null,
    markMain: marks.main ?? null,
    firstPaint: after('firstPaint'),
    loaded: after('loaded'),
    ...mem,
    wasmMB: info.wasm ? Math.round(info.wasm / 1048576) : null,
    memHighMB: memHigh,
    rx: net1.rx - net0.rx,
    tx: net1.tx - net0.tx,
    title: (info.title || '').slice(0, 60),
    errors: logs.filter((l) => /PAGEERROR|Aborted|crash/i.test(l)).slice(0, 5),
  };
}

await makeTemplate();
for (const site of sites) {
  for (let run = 0; run < runs; run++) {
    for (const config of armOrder(configs, run)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-run-'));
      fs.cpSync(TEMPLATE, dir, { recursive: true });
      const rows = [['cold', await measure(dir, site, config, visit === 'warm' ? 8000 : 0)]];
      if (visit === 'warm') rows.push(['warm', await measure(dir, site, config, 0)]);
      fs.rmSync(dir, { recursive: true, force: true });
      for (const [kind, r] of rows) {
        const row = {
          label,
          profile,
          net,
          site,
          config: config.name,
          engineSite: config.site,
          visit: kind,
          run,
          ...r,
        };
        fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
        console.log(
          `${profile} ${net} ${site} ${config.name} ${kind} #${run}: ${r.status} layout ${r.firstLayout} paint ${r.firstPaint} loaded ${r.loaded} ms, cpu ${r.cpu} s, anon ${r.anonMB} MB`,
        );
      }
    }
  }
}
process.exit(0);
