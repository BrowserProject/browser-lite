// Start of the engine: per run a new Chromium profile with three starts in a row (1: nothing
// cached, 2 and 3: engine in the HTTP cache and the code cache of V8). Measured: when the browser
// of the demo is ready, the first layout of example.com, the download of engine.wasm and the size
// of the WebAssembly code cache of Chromium in the profile.
//   node start.mjs --out <jsonl> --runs n --ca <pem> [--label x]
import fs from 'node:fs';
import { createServer, connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out');
const runs = Number(arg('runs', 3));
const label = arg('label', '');
const ca = fs.readFileSync(arg('ca'), 'utf8');
const upstream = new URL(process.env.SERVER);
const forwarder = createServer((client) => {
  const server = connect(Number(upstream.port), upstream.hostname);
  client.pipe(server).pipe(client);
  client.on('error', () => server.destroy());
  server.on('error', () => client.destroy());
});
await new Promise((resolve) => forwarder.listen(8080, '127.0.0.1', resolve));

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
const rxBytes = () => Number(fs.readFileSync('/sys/class/net/eth0/statistics/rx_bytes', 'utf8'));

for (let run = 0; run < runs; run++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-start-'));
  for (let start = 1; start <= 3; start++) {
    const context = await chromium.launchPersistentContext(dir, {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(HOOKS);
    await context.addInitScript((pem) => {
      window.blTestOptions = { engine: { extraCA: pem } };
    }, ca);
    const page = context.pages()[0] || (await context.newPage());
    const rx0 = rxBytes();
    await page.goto(
      `http://localhost:8080/?debug=1&url=${encodeURIComponent('https://example.com/')}`,
    );
    let status = 'ok';
    await page
      .waitForFunction(() => window.__perf?.firstLayout != null, null, {
        timeout: 300000,
        polling: 100,
      })
      .catch(() => {
        status = 'timeout';
      });
    const info = await page.evaluate(() => ({
      perf: window.__perf,
      wasm: performance
        .getEntriesByType('resource')
        .filter((r) => /engine\.wasm/.test(r.name))
        .map((r) => ({ duration: Math.round(r.duration), size: r.transferSize }))[0],
    }));
    const rx = rxBytes() - rx0;
    // Chromium writes the code cache with a delay
    await page.waitForTimeout(5000);
    await context.close();
    const p = info.perf || {};
    const row = {
      kind: 'start',
      label,
      profile: process.env.PERF_PROFILE,
      net: process.env.PERF_NET,
      run,
      start,
      status,
      ready: Math.round(p.ready),
      firstLayout: Math.round(p.firstLayout),
      layoutAfterReady: Math.round(p.firstLayout - p.ready),
      wasmDuration: info.wasm?.duration,
      wasmSize: info.wasm?.size,
      rx,
      wasmCodeCacheMB: +(
        dirSize(path.join(dir, 'Default', 'Code Cache', 'wasm')) / 1048576
      ).toFixed(1),
    };
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(
      `${row.profile} ${row.net} #${run} start ${start}: ready ${row.ready} ms, layout ${row.firstLayout} ms, wasm ${row.wasmDuration} ms ${row.wasmSize} B, code cache ${row.wasmCodeCacheMB} MB`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
forwarder.close();
process.exit(0);
