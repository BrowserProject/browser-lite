// Records which engine functions run, for the split of engine.wasm (#238, tools/split-engine.mjs):
// starts the demo in Chromium with the unsplit engine (engine.full.wasm of a build, with function
// names) on a first visit and again after a restart, and the core's test host page, with a local
// page, then each site in a fresh Chromium, scrolled; V8 compiles each function at its first call.
// engine/hot-functions.txt gets what the start, MIN_SITES of the sites or the page main thread
// ran as hot, the other functions of the build as cold. Run it after changes that add or rename
// much engine code (a WebKit update), or when tests/core/deferred-test.mjs finds the start
// needing a chunk: functions newer than the list stay in engine.wasm. The start includes a page
// with text in other scripts whose fonts are held back (#255: the text goes on without them).
// --add runs only that page and the given urls and marks what ran as hot in the existing list.
//
//   node tools/hot-functions.mjs <engine-dir> [--seconds 25] [--out engine/hot-functions.txt] [--add] [url...]
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
import { functionNames, wasmImports } from './wasm-binary.mjs';

// Sites that must have run a function for it to stay in engine.wasm. With 2 the start needed 1 MB
// less, but Wikipedia then waited for chunk after chunk: first paint at 5 Mbit/s after 44 instead
// of 24.5 s (#238)
const MIN_SITES = 1;

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
    add: { type: 'boolean', default: false },
  },
});
const [engineDir, ...urls] = positionals;
if (!engineDir) {
  console.error(
    'Usage: hot-functions.mjs <engine-dir> [--seconds 25] [--out file] [--add] [url...]',
  );
  process.exit(2);
}
const sites = urls.length || options.add ? urls : SITES;

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
// Text in scripts whose fonts are lazy fallback fonts, in a grid (measured more than once)
const FONTS = `<!doctype html><title>Scripts</title><style>body{font:16px sans-serif;margin:40px}
ul{display:grid;grid-template-columns:repeat(4,auto)}</style><ul>
<li lang="th">ภาษาไทย</li><li lang="hi">हिन्दी</li><li lang="ar">العربية</li><li lang="bn">বাংলা</li>
<li lang="ko">한국어</li><li lang="ja">日本語</li><li lang="zh">中文</li><li lang="am">አማርኛ</li>
<li lang="my">မြန်မာ</li><li lang="ta">தமிழ்</li><li>😀 🚀</li><li lang="si">සිංහල</li></ul>`;
const local = await serve((req, res) => {
  const image = req.url === '/image.svg';
  res.writeHead(200, { 'Content-Type': image ? 'image/svg+xml' : 'text/html; charset=utf-8' });
  res.end(
    image
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>'
      : req.url === '/fonts'
        ? FONTS
        : LOCAL,
  );
});
const fontsPage = new URL('fonts', local.url).href;

const seconds = Number(options.seconds) * 1000;

/**
 * One start of Chromium with the app, then the pages one after the other; resolves what ran
 * (function index -> ran on the page main thread). holdFonts: the lazy fallback fonts never
 * arrive.
 */
async function scenario(stack, profile, pages, { holdFonts = false } = {}) {
  const context = await launchProfile({
    dir: profile,
    args: SWIFTSHADER,
    viewport: { width: 1280, height: 860 },
  });
  if (holdFonts) await context.route(/\/lazy\/fonts\/(scripts|cjk|emoji)\//, () => {});
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
  return new Map(
    [...ran].map(([index, tids]) => [
      index,
      [...tids].some((tid) => threads.get(tid) === 'CrRendererMain'),
    ]),
  );
}

const merge = (into, ran) => {
  for (const [index, main] of ran) into.set(index, main || !!into.get(index));
};

// What the start needs: the demo on a first visit and again after a restart (stored data), the
// core's test host page (storage in memory), each with the local page; text in other scripts
// before their fonts are there
const start = new Map();
const demo = await startStack({ app: 'demo', engine });
merge(start, await scenario(demo, tempDir('hot-profile'), [fontsPage], { holdFonts: true }));
if (!options.add) {
  const profile = tempDir('hot-profile');
  merge(start, await scenario(demo, profile, [local.url]));
  merge(start, await scenario(demo, profile, [local.url]));
  const core = await startStack({ engine });
  merge(start, await scenario(core, tempDir('hot-profile'), [local.url]));
}

// Each site in a fresh Chromium (V8 compiles a function once per process), to count the sites
const counts = new Map();
const main = new Map(start);
for (const url of sites) {
  const ran = await scenario(demo, tempDir('hot-profile'), [url]);
  for (const index of ran.keys()) counts.set(index, (counts.get(index) ?? 0) + 1);
  merge(main, ran);
}

// Hot: what the start or MIN_SITES sites ran, and what ran on the page main thread; the other
// functions of this build are cold. Names that share a hash: hot wins.
const importedFunctions = wasmImports(readFileSync(fullWasm)).filter(
  (entry) => entry.kind === 'function',
).length;
const list = options.add ? readHotList(options.out) : new Map();
for (const [index, name] of names) {
  if (index < importedFunctions) continue;
  const hash = nameHash(name);
  const hot = start.has(index) || main.get(index) || (counts.get(index) ?? 0) >= MIN_SITES;
  if (hot) list.set(hash, { main: !!main.get(index) || !!list.get(hash)?.main, cold: false });
  else if (!list.has(hash) && !options.add) list.set(hash, { main: false, cold: true });
}
writeHotList(options.out, list);
const cold = [...list.values()].filter((entry) => entry.cold).length;
console.log(`${list.size - cold} hot and ${cold} cold in ${options.out}`);
process.exit(0);
