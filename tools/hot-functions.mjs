// Records which engine functions run, for the split of engine.wasm (#238, tools/split-engine.mjs):
// starts the demo in Chromium with the unsplit engine (engine.full.wasm of a build, with function
// names) on a first visit and again after a restart, and the core's test host page, loads a local
// page and the sites one after the other and scrolls them, and adds every function V8 compiled
// meanwhile (it compiles each function at its first call) to engine/hot-functions.txt.
// Run it after changes that add or rename much engine code (a WebKit update): functions missing
// from the list still work, a thread only waits for the chunk of one when it needs it before
// the download is through.
//
//   node tools/hot-functions.mjs <engine-dir> [--seconds 25] [--out engine/hot-functions.txt] [url...]
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  launchProfile,
  SWIFTSHADER,
  serve,
  startStack,
  TIMEOUT,
  tempDir,
} from '../tests/lib/index.mjs';
import { nameHash, readHotList, writeHotList } from './hot-functions-file.mjs';
import { functionNames } from './wasm-binary.mjs';

const SITES = [
  'https://en.wikipedia.org/wiki/Switzerland',
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  'https://github.com/WebKit/WebKit',
  'https://www.bbc.com/news',
  'https://www.google.com/search?q=web+browser',
  'https://www.reddit.com/',
  'https://www.amazon.com/',
  'https://www.nytimes.com/',
  'https://www.20min.ch/',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://weather.com/',
  'https://www.openstreetmap.org/',
];

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: 'string', default: '25' },
    out: {
      type: 'string',
      default: path.join(import.meta.dirname, '..', 'engine', 'hot-functions.txt'),
    },
  },
});
const [engineDir, ...urls] = positionals;
if (!engineDir) {
  console.error('Usage: hot-functions.mjs <engine-dir> [--seconds 25] [--out file] [url...]');
  process.exit(2);
}
const sites = urls.length ? urls : SITES;

// The demo with the unsplit engine: links to the build, engine.full.wasm as engine.wasm
const fullWasm = ['engine.full.wasm', 'engine.wasm']
  .map((name) => path.resolve(engineDir, name))
  .find((file) => existsSync(file));
const names = functionNames(readFileSync(fullWasm));
if (!names.size) throw new Error(`${fullWasm} has no function names`);
const engine = path.join(tempDir('hot-engine'), 'engine');
mkdirSync(engine);
for (const name of ['engine.js', 'engine.data', 'lazy'])
  symlinkSync(path.resolve(engineDir, name), path.join(engine, name));
symlinkSync(fullWasm, path.join(engine, 'engine.wasm'));

// A small local page: text, an SVG image, a form and a table
const LOCAL = `<!doctype html><title>Local</title><style>body{font:16px sans-serif;margin:40px}</style>
<h1>Local page</h1><p>${'Some text for the first paint of a simple page. '.repeat(30)}</p>
<img src="image.svg" width="200" height="100"><form><input name="q" value="text"><select><option>a</option></select><button>Go</button></form>
<table><tr><th>a</th><td>1</td></tr></table>`;
const local = await serve((req, res) => {
  const image = req.url === '/image.svg';
  res.writeHead(200, { 'Content-Type': image ? 'image/svg+xml' : 'text/html; charset=utf-8' });
  res.end(
    image
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>'
      : LOCAL,
  );
});

// Function index -> ran on the page main thread, over all scenarios
const compiled = new Map();
const seconds = Number(options.seconds) * 1000;

/** One start of Chromium with the app, then the pages one after the other. */
async function scenario(stack, profile, pages) {
  const context = await launchProfile({
    dir: profile,
    args: SWIFTSHADER,
    viewport: { width: 1280, height: 860 },
  });
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const threads = new Map();
  const ran = new Map();
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) {
      if (event.ph === 'M' && event.name === 'thread_name') threads.set(event.tid, event.args.name);
      if (event.name !== 'wasm.CompileLazy' || event.args?.func_index === undefined) continue;
      const tids = ran.get(event.args.func_index) ?? new Set();
      ran.set(event.args.func_index, tids.add(event.tid));
    }
  });
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['v8.wasm', 'disabled-by-default-v8.wasm.detailed'] },
    transferMode: 'ReportEvents',
  });
  await page.goto(stack.app({ url: pages[0] }));
  await page.waitForFunction(() => window.blTest?.browser?.ready, null, { timeout: TIMEOUT });
  for (const [index, url] of pages.entries()) {
    if (index) await page.evaluate((address) => window.blTest.load(address), url);
    await page.waitForTimeout(seconds / 2);
    // Scrolling runs the code of lazy content and of the scrolling thread
    await page.mouse.move(640, 500);
    for (let step = 0; step < 6; step++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(seconds / 12);
    }
    console.log(`${url}: ${await page.evaluate(() => document.title)}`);
  }
  const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  await complete;
  await context.close();
  for (const [index, tids] of ran) {
    const main = [...tids].some((tid) => threads.get(tid) === 'CrRendererMain');
    compiled.set(index, main || !!compiled.get(index));
  }
}

// The demo on a first visit, again after a restart (stored data), and the core's test host page
// (storage in memory)
const demo = await startStack({ app: 'demo', engine });
const profile = tempDir('hot-profile');
await scenario(demo, profile, [local.url, ...sites]);
await scenario(demo, profile, [local.url, ...sites.slice(0, 3)]);
const core = await startStack({ engine });
await scenario(core, tempDir('hot-profile'), [local.url, ...sites.slice(0, 3)]);

const list = readHotList(options.out);
const before = list.size;
for (const [index, main] of compiled) {
  const name = names.get(index);
  if (!name) continue;
  const hash = nameHash(name);
  list.set(hash, { main: main || !!list.get(hash)?.main });
}
writeHotList(options.out, list);
console.log(
  `${compiled.size} functions ran, ${list.size - before} new, ${list.size} in ${options.out}`,
);
process.exit(0);
