// Measurement run in the device container: loads sites in the demo and writes one JSON line per
// load. Configurations (A/B) take turns per run (ABBA).
//
//   node run.mjs --out <jsonl> --runs <n> --visit cold|warm --sites wiki,cnn,...
//                [--configs '<json>'] [--ca <pem>] [--timeout <s>] [--label <text>]
//                [--logs <dir>] [--linger <ms>]
//
// configs: [{"name":"A","params":{"log":"1"}}, ...], params go into the URL of the demo.
// cold: a new browser profile from the template (engine in the HTTP and code cache of Chromium,
// browser-lite itself empty). warm: then the browser restarts and loads the same site again (HTTP
// cache, bytecode cache, service workers). Times are milliseconds after the browser of the demo
// is ready.
import fs from 'node:fs';
import { createServer, connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const SITES = {
  example: 'https://example.com/',
  wiki: 'https://de.wikipedia.org/wiki/Schweiz',
  cnn: 'https://edition.cnn.com/',
  min20: 'https://www.20min.ch/',
  weather: 'https://weather.com/',
  youtube: 'https://www.youtube.com/',
  github: 'https://github.com/WebKit/WebKit',
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out');
const runs = Number(arg('runs', 3));
const visit = arg('visit', 'cold');
const label = arg('label', '');
const configs = JSON.parse(arg('configs', '[{"name":"A","params":{}}]'));
const sites = arg('sites', 'example').split(',');
const caFile = arg('ca');
const ca = caFile ? fs.readFileSync(caFile, 'utf8') : null;
const TIMEOUT = Number(arg('timeout', 400)) * 1000;
const logDir = arg('logs');
const linger = Number(arg('linger', 0));
const net = process.env.PERF_NET || '?';
const profile = process.env.PERF_PROFILE || '?';

// The demo needs a secure context (OPFS, Cache API): it opens as localhost in the device, a
// forwarder sends everything over the shaped link to the server. A flag that treats the server
// address as secure is not enough (navigator.storage stays missing).
const upstream = new URL(process.env.SERVER);
const forwarder = createServer((client) => {
  const server = connect(Number(upstream.port), upstream.hostname);
  client.pipe(server).pipe(client);
  client.on('error', () => server.destroy());
  server.on('error', () => client.destroy());
});
await new Promise((resolve) => forwarder.listen(8080, '127.0.0.1', resolve));
const SERVER = 'http://localhost:8080';
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const TEMPLATE = path.join(os.tmpdir(), 'bl-perf-template');

const readNumber = (file) => {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
};
const cpuSeconds = () =>
  Number(/usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))[1]) / 1e6;
const netBytes = () => ({
  rx: readNumber('/sys/class/net/eth0/statistics/rx_bytes'),
  tx: readNumber('/sys/class/net/eth0/statistics/tx_bytes'),
});

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

async function launch(dir) {
  const context = await chromium.launchPersistentContext(dir, {
    args: ARGS,
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(HOOKS);
  if (ca)
    await context.addInitScript((pem) => {
      window.blTestOptions = { engine: { extraCA: pem } };
    }, ca);
  return context;
}

async function makeTemplate() {
  if (fs.existsSync(TEMPLATE)) return;
  const context = await launch(TEMPLATE);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(`${SERVER}/?debug=1&url=about:blank`);
  await page.waitForFunction(() => window.__perf?.ready, null, { timeout: 300000 });
  await page.waitForTimeout(5000);
  await context.close();
}

async function measure(dir, site, config, stay) {
  const context = await launch(dir);
  const page = context.pages()[0] || (await context.newPage());
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message}`));
  const cpu0 = cpuSeconds();
  const net0 = netBytes();
  const t0 = Date.now();
  const query = new URLSearchParams({ url: SITES[site] || site, debug: '1', ...config.params });
  await page.goto(`${SERVER}/?${query}`);
  let status = 'ok';
  try {
    await page.waitForFunction(() => window.__perf?.loaded != null, null, {
      timeout: TIMEOUT,
      polling: 100,
    });
  } catch {
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
  const wall = Date.now() - t0;
  // Before the second visit stay like a user: the engine stores the bytecode cache 5 s after load
  if (linger || stay) await page.waitForTimeout(Math.max(linger, stay));
  const cpu = cpuSeconds() - cpu0;
  const net1 = netBytes();
  const info = await page
    .evaluate(() => ({
      perf: window.__perf,
      title: document.title,
      crashed: window.blTest?.browser?.state === 'crashed',
    }))
    .catch((e) => ({ error: e.message }));
  const memory = readNumber('/sys/fs/cgroup/memory.current');
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
    firstPaint: after('firstPaint'),
    loaded: after('loaded'),
    memMB: memory ? Math.round(memory / 1048576) : null,
    rx: net1.rx - net0.rx,
    tx: net1.tx - net0.tx,
    title: (info.title || '').slice(0, 60),
    errors: logs.filter((l) => /PAGEERROR|Aborted|crash/i.test(l)).slice(0, 5),
  };
}

await makeTemplate();
for (const site of sites) {
  for (let run = 0; run < runs; run++) {
    const order = run % 2 === 0 ? configs : [...configs].reverse();
    for (const config of order) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-run-'));
      fs.cpSync(TEMPLATE, dir, { recursive: true });
      const rows = [['cold', await measure(dir, site, config, visit === 'warm' ? 8000 : 0)]];
      if (visit === 'warm') rows.push(['warm', await measure(dir, site, config, 0)]);
      fs.rmSync(dir, { recursive: true, force: true });
      for (const [kind, r] of rows) {
        const row = { label, profile, net, site, config: config.name, visit: kind, run, ...r };
        fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
        console.log(
          `${profile} ${net} ${site} ${config.name} ${kind} #${run}: ${r.status} layout ${r.firstLayout} paint ${r.firstPaint} loaded ${r.loaded} ms, cpu ${r.cpu} s`,
        );
      }
    }
  }
}
forwarder.close();
process.exit(0);
