// Start of the demo on a slow link, by hand: first visit (empty Chromium profile) and second visit
// (same profile), several runs, medians. The demo and its relay run behind shaper.mjs, so the
// engine download and every page byte take the slow link; the relay reaches the sites directly.
//
//   node tests/bench/slow-start.mjs --site <dir> [--runs 3] [--rtt 150] [--down 5000] [--up 1000]
//                                   [--url <address>] [--cores <list>] [--seconds 120]
//
// --site is a folder of tools/package-demo.sh (Brotli files and the engine under engine/<hash>/
// like on the server). Without --url a local test page loads (text and an image, served from
// 127.0.0.1 through the relay). --cores runs Chromium with taskset on these CPUs (for example
// 0,1). Times are milliseconds from the navigation of the demo: `ready` (the browser started),
// `firstPaint` and `loaded` of the page; `engineKB` is what the engine files transferred.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { SWIFTSHADER, launchProfile } from '../lib/chromium.mjs';
import { serve } from '../lib/pages.mjs';
import { startServer, tempDir } from '../lib/processes.mjs';
import { startShaper } from './shaper.mjs';

const { values: options } = parseArgs({
  options: {
    site: { type: 'string' },
    runs: { type: 'string', default: '3' },
    rtt: { type: 'string', default: '150' },
    down: { type: 'string', default: '5000' },
    up: { type: 'string', default: '1000' },
    url: { type: 'string' },
    cores: { type: 'string' },
    seconds: { type: 'string', default: '120' },
  },
});
if (!options.site) {
  console.error('Usage: slow-start.mjs --site <folder of tools/package-demo.sh> [options]');
  process.exit(2);
}

const PAGE = `<!doctype html><title>Bench</title><style>body{font:16px sans-serif;margin:40px}</style>
<h1>Slow start</h1><p>${'A page with some text for the first paint. '.repeat(40)}</p>
<img src="image.svg" width="200" height="100">`;
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>';
const local = await serve((req, res) => {
  const image = req.url === '/image.svg';
  res.writeHead(200, { 'Content-Type': image ? 'image/svg+xml' : 'text/html' });
  res.end(image ? IMAGE : PAGE);
});
const target = options.url ?? local.url;

const server = await startServer({
  SITE_DIR: options.site,
  PROFILE_DIR: tempDir('bench-profile'),
  RELAY_ALLOW_LOCAL: '1',
});
const shaper = await startShaper({
  target: server.port,
  rttMs: Number(options.rtt),
  downKbit: Number(options.down),
  upKbit: Number(options.up),
});
// localhost is a secure context (OPFS, caches); 127.0.0.1 would be another origin for the relay
const demo = `http://localhost:${shaper.port}/?${new URLSearchParams({ debug: '1', url: target })}`;

// Runs in the page: times of the start and of the first page, from the navigation on
const RECORD = () => {
  const times = {};
  window.benchTimes = times;
  const timer = setInterval(() => {
    const test = window.blTest;
    if (!test) return;
    if (!times.ready && test.browser?.ready) times.ready = performance.now();
    if (!times.firstPaint && test.flags.firstPaint) times.firstPaint = performance.now();
    // A page from the cache can finish loading before its first paint
    if (!times.loaded && test.flags.loaded) times.loaded = performance.now();
    if (times.loaded && times.firstPaint) clearInterval(timer);
  }, 20);
};

async function visit(page) {
  await page.goto(demo);
  const end = Date.now() + Number(options.seconds) * 1000;
  let times = {};
  while (Date.now() < end) {
    times = await page.evaluate(() => window.benchTimes);
    if (times.loaded && times.firstPaint) break;
    await page.waitForTimeout(200);
  }
  const engineKB = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => /\/engine\/[^?]*\/(engine\.|lazy\/)/.test(entry.name))
        .reduce((sum, entry) => sum + entry.transferSize, 0) / 1024,
  );
  return { ...times, engineKB };
}

const args = [...SWIFTSHADER];
if (options.cores) {
  // Playwright starts the executable given here: a wrapper that pins it to the cores
  const wrapper = `${tempDir('bench-chromium')}/chromium`;
  const { chromium } = await import('playwright');
  spawnSync('sh', [
    '-c',
    `printf '#!/bin/sh\\nexec taskset -c %s "%s" "$@"\\n' '${options.cores}' '${chromium.executablePath()}' > ${wrapper} && chmod +x ${wrapper}`,
  ]);
  process.env.CHROMIUM_PATH = wrapper;
}

const rows = { first: [], second: [] };
for (let run = 1; run <= Number(options.runs); run++) {
  const context = await launchProfile({ args, viewport: { width: 1280, height: 800 } });
  await context.addInitScript(RECORD);
  const page = await context.newPage();
  for (const name of ['first', 'second']) {
    const row = await visit(page);
    rows[name].push(row);
    console.log(
      `run ${run} ${name}:`,
      JSON.stringify(row, (_, v) => (typeof v === 'number' ? Math.round(v) : v)),
    );
  }
  await context.close();
}

const median = (values) => {
  const sorted = values.filter((value) => value !== undefined).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : '-';
};
console.log(`\nlink: rtt ${options.rtt} ms, ${options.down}/${options.up} kbit; page ${target}`);
console.log('visit    ready  firstPaint  loaded  engineKB');
for (const [name, list] of Object.entries(rows)) {
  const cell = (key, width) => String(median(list.map((row) => row[key]))).padStart(width);
  console.log(
    `${name.padEnd(7)}${cell('ready', 7)}${cell('firstPaint', 12)}${cell('loaded', 8)}${cell('engineKB', 10)}`,
  );
}
shaper.close();
local.server.close();
process.exit(0);
