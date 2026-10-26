// Split engine (#238, tools/split-engine.mjs, engine/js/deferred.js): the chunks
// engine.deferred-<n>.wasm load after the start. The start and a simple page need none of them
// (otherwise engine/hot-functions.txt is out of date: tools/hot-functions.mjs). A page that needs
// deferred code (XSLT) while they are held back still works: the engine thread reads its chunk
// itself and waits for it.
// Once the host has all chunks they reach all threads, and another page with deferred code
// (MathML, SVG filters) needs no further request. An unsplit engine skips the test.
//
//   node tests/core/deferred-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  check,
  collect,
  engineDir,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const chunks = fs
  .readdirSync(engineDir)
  .filter((name) => /^engine\.deferred-\d+\.wasm$/.test(name));
if (!chunks.length) {
  console.log('skip: the engine is not split');
  process.exit(0);
}

const PAGES = {
  // Text, an image, a form: what the start and common pages run
  simple: `<!doctype html><title>Simple</title><style>body{font:16px sans-serif;margin:40px}</style>
<h1>Simple</h1><p>${'Some text of a simple page. '.repeat(30)}</p>
<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
<form><input value="text"><button>Go</button></form>
<script>requestAnimationFrame(() => requestAnimationFrame(() => console.log('RESULT simple=1')));</script>`,
  // XSLTProcessor: code the common pages of engine/hot-functions.txt do not run
  xslt: `<!doctype html><title>XSLT</title><script>
const parse = (text) => new DOMParser().parseFromString(text, 'application/xml');
const xsl = parse('<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><b><xsl:value-of select="count(//item)"/></b></xsl:template></xsl:stylesheet>');
const processor = new XSLTProcessor();
processor.importStylesheet(xsl);
const result = processor.transformToFragment(parse('<list><item/><item/><item/></list>'), document);
console.log('RESULT xslt=' + result.textContent);
</script>`,
  math: `<!doctype html><title>Math</title><body>
<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>
<svg width="60" height="60"><filter id="f"><feTurbulence baseFrequency="0.05"/><feGaussianBlur stdDeviation="2"/></filter><rect width="60" height="60" filter="url(#f)"/></svg>
<script>requestAnimationFrame(() => requestAnimationFrame(() => console.log('RESULT math=' + Math.round(document.querySelector('mfrac').getBoundingClientRect().height > 0))));</script>`,
};
const { url: siteURL } = await serve((req, res) => {
  const page = PAGES[req.url.slice(1)];
  res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }).end(page ?? '');
});

const stack = await startStack();
const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
watchErrors(page);
const results = collect(page);

// The chunks: every request waits until released (the host's fetches and a thread's own)
const HOLD_MS = 4000;
let requests = 0;
let released = false;
let heldBack = 0;
let startRelease = () => {};
const release = new Promise((resolve) => {
  startRelease = () => setTimeout(resolve, HOLD_MS);
  // A start that needs a chunk would wait for it: it gets it later and the check below fails
  setTimeout(resolve, 30000);
}).then(() => {
  released = true;
  heldBack = requests;
});
await context.route('**/engine.deferred-*.wasm', async (route) => {
  requests++;
  await release;
  await route.continue();
});

check(
  'starts while the chunks are held back',
  await openHost(page, stack.app({ url: new URL('simple', siteURL).href })),
);
check('a simple page loads', (await results.wait('simple')) === '1');
await page.waitForTimeout(1000);
// The host asks for one chunk at a time
check(
  'the start and a simple page need no deferred code',
  requests === 1,
  `${requests} chunk requests`,
);

startRelease();
await load(page, new URL('xslt', siteURL).href);
check('a page with deferred code works', (await results.wait('xslt')) === '3', results.get('xslt'));
check('it waited for its chunk', released);
// The host asks for one chunk at a time, so a second waiting request came from the engine thread
check('the engine thread requested it itself', heldBack >= 2, `${heldBack} chunk requests waited`);

// The host fetches every chunk once, one after the other
await waitFor(() => requests >= chunks.length + 1, 30000);
await page.waitForTimeout(1000);
const before = requests;
await load(page, new URL('math', siteURL).href);
check('another page with deferred code works', (await results.wait('math')) === '1');
await page.waitForTimeout(1000);
check('no further request for it', requests === before, `${before} -> ${requests}`);

await browser.close();
finish();
