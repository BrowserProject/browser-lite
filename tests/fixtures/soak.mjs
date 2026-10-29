// Long run shared by core/soak-test.mjs (core API) and demo/soak-test.mjs (demo UI): many
// navigations through different pages (DOM with an iframe, images, worker, WebAssembly, audio) in
// one view, then open and close views or tabs. Afterwards (everything releasable released, full
// GC) the documents must be back at the state after the warm up and malloc and the WASM memory
// may only have grown a little, else something lives on per page. The host renderer and GPU
// process must not keep anything per closed view either (canvas pixels).
//
// SOAK_ROUNDS (default 40) rounds through all pages, SOAK_TABS (default 30) views or tabs.
import fs from 'node:fs';
import path from 'node:path';
import {
  TIMEOUT,
  VERBOSE,
  check,
  chromiumOnly,
  root,
  serve,
  serveBytes,
  waitFor,
  wav,
} from '../lib/index.mjs';

const ROUNDS = Number(process.env.SOAK_ROUNDS || 40);
const TABS = Number(process.env.SOAK_TABS || 30);
const WARMUP = 2;

// Uncompressed BMP (24 bit), every image with its own colors
function bmp(size, seed) {
  const row = size * 3;
  const buffer = Buffer.alloc(54 + row * size);
  buffer.write('BM', 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(size, 18);
  buffer.writeInt32LE(size, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(row * size, 34);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++)
      buffer.set([(x * seed) & 255, (y * 3) & 255, (seed * 40) & 255], 54 + y * row + x * 3);
  }
  return buffer;
}

const done = (name) =>
  `const round = new URLSearchParams(location.search).get('r'); console.log('RESULT done=${name}-' + round)`;
const PAGES = {
  empty: `<!doctype html><title>empty</title><p>empty<script>${done('empty')}</script>`,
  dom: `<!doctype html><title>dom</title><style>.c{display:inline-block;padding:2px;margin:1px;border:1px solid #ccc;border-radius:3px}</style>
<div id="list"></div><iframe srcdoc="<p>in the iframe</p><script>parent.postMessage('frame', '*')</script>"></iframe>
<script>const list = document.getElementById('list');
for (let i = 0; i < 3000; i++) { const div = document.createElement('div'); div.className = 'c'; div.textContent = 'Element ' + i; div.onclick = () => div.remove(); list.append(div); }
const objects = []; for (let i = 0; i < 20000; i++) objects.push({ i, text: 'x' + i, next: objects[i - 1] });
window.keep = objects;
addEventListener('message', () => { document.body.offsetHeight; ${done('dom')} });</script>`,
  images: `<!doctype html><title>images</title>${[0, 1, 2, 3].map((i) => `<img src="/image${i}.bmp" width="256" height="256">`).join('')}
<script>Promise.all([...document.images].map((img) => img.decode())).then(() => { ${done('images')} }, (e) => console.log('RESULT done=error-' + e))</script>`,
  worker: `<!doctype html><title>worker</title><script>
const source = 'onmessage = (e) => { let sum = 0; const data = new Float64Array(e.data); for (let i = 0; i < data.length; i++) sum += i; postMessage(sum); }';
const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
worker.onmessage = (e) => { if (e.data === 1048575 * 1048576 / 2) { ${done('worker')} } };
worker.postMessage(1 << 20);</script>`,
  wasm: `<!doctype html><title>wasm</title><script>
fetch('/small.wasm').then((r) => r.arrayBuffer()).then((bytes) => WebAssembly.instantiate(bytes, {})).then(({ instance }) => {
  instance.exports.grow(4);
  if (typeof instance.exports.sum() === 'number') { ${done('wasm')} }
});</script>`,
  audio: `<!doctype html><title>audio</title><audio src="/tone.wav" preload="auto"></audio><script>
document.querySelector('audio').addEventListener('loadedmetadata', () => { ${done('audio')} });</script>`,
};
const SEQUENCE = ['dom', 'images', 'worker', 'wasm', 'audio'];

/**
 * Resident memory in MB of the renderers and the GPU process of Chromium (triggers no garbage
 * collection), null where it cannot be read (not Linux, no browser object, not Chromium).
 */
async function hostMemory(page) {
  const browser = page.context().browser();
  if (process.platform !== 'linux' || !browser) return null;
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  let kB = 0;
  for (const { id, type } of processInfo) {
    if (type !== 'renderer' && type !== 'GPU') continue;
    try {
      kB += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${id}/status`, 'utf8'))?.[1] ?? 0);
    } catch {}
  }
  return Math.round(kB / 1024);
}

/** Serves the soak pages; resolves the site address (ends with /). */
export async function serveSoakPages() {
  const images = [1, 2, 3, 4].map((seed) => bmp(512, seed));
  const tone = wav(5, { frequency: 0 });
  const smallWasm = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'wasm', 'small.wasm'));
  const { url } = await serve((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    if (PAGES[name])
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[name]);
    const image = /^image(\d)\.bmp$/.exec(name);
    if (image)
      return res
        .writeHead(200, { 'Content-Type': 'image/bmp', 'Cache-Control': 'max-age=3600' })
        .end(images[image[1]]);
    if (name === 'small.wasm')
      return res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(smallWasm);
    if (name === 'tone.wav') return serveBytes(req, res, tone, 'audio/wav');
    res.writeHead(404).end();
  });
  return url;
}

/**
 * Runs the soak checks in page (window.blTest available).
 * @param {object} o
 * @param {import('playwright').Page} o.page
 * @param {string} o.siteURL address of serveSoakPages()
 * @param {(url: string) => Promise<unknown>} o.start opens the page under test with url
 * @param {(url: string) => Promise<unknown>} o.go loads url in the active view or tab
 * @param {(url: string) => Promise<unknown>} o.openTab opens a new view or tab with url
 * @param {() => Promise<unknown>} o.closeTab closes the active view or tab
 * @param {() => Promise<number>} o.tabCount number of open views or tabs
 * @param {string} o.unit 'views' or 'tabs' (labels)
 */
export async function soak({ page, siteURL, start, go, openTab, closeTab, tabCount, unit }) {
  const finished = new Set();
  const reportLines = [];
  // The marking chain of memory report 4 comes from JSC's verifier without the [memory] prefix
  let inMarking = false;
  page.on('console', (msg) => {
    const text = msg.text();
    if (VERBOSE) console.log('   ', text);
    const match = /RESULT done=(\S+)/.exec(text);
    if (match) finished.add(match[1]);
    if (text.includes('[memory]   marking ')) inMarking = !text.includes('marking end');
    if (text.includes('[memory]') || inMarking) reportLines.push(text.slice(0, 400));
  });
  async function waitDone(key, ms = 30000) {
    for (
      const end = Date.now() + ms;
      Date.now() < end;
      await new Promise((r) => setTimeout(r, 50))
    ) {
      if (finished.has(key)) return true;
    }
    return false;
  }

  // Everything releasable released, full GC (memory report 3), then the report of the engine
  async function measure() {
    await page.waitForTimeout(500);
    reportLines.length = 0;
    const line = page.waitForEvent('console', {
      predicate: (msg) => /malloc used \d+ MB/.test(msg.text()),
      timeout: 60000,
    });
    await page.evaluate(() => window.blTest.memory(3));
    const text = (await line).text();
    await page.waitForTimeout(500);
    return {
      malloc: Number(/malloc used (\d+) MB/.exec(text)[1]),
      documents: Number(/documents (\d+)/.exec(text)[1]),
      wasm: Math.round((await page.evaluate(() => window.blTest.memory())) / 2 ** 20),
      players: await page.evaluate(() => window.blTest.mediaState().length),
      documentList: reportLines.filter((l) => l.includes('doc refs=')),
    };
  }

  // Work still running (decoding sound, compiling WebAssembly) holds the documents of the last
  // pages for a moment: measure until the number no longer drops, with `limit` until it is at
  // most that (a slow machine needs longer), at most 20 s
  async function measureSettled(limit = Number.POSITIVE_INFINITY) {
    let best = await measure();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(2000);
      const next = await measure();
      if (next.documents >= best.documents && best.documents <= limit) return best;
      if (next.documents < best.documents) best = next;
    }
    return best;
  }

  await start(`${siteURL}empty?r=start`);
  check('first page', await waitDone('empty-start', TIMEOUT));

  let navigations = 0;
  let failedAt = null;
  async function rounds(from, to) {
    for (let round = from; round < to && !failedAt; round++) {
      for (const name of SEQUENCE) {
        await go(`${siteURL}${name}?r=${round}`);
        navigations++;
        if (!(await waitDone(`${name}-${round}`))) {
          failedAt = `${name}-${round}`;
          return;
        }
      }
    }
  }

  const started = Date.now();
  await rounds(0, WARMUP);
  await go(`${siteURL}empty?r=base`);
  await waitDone('empty-base');
  const base = await measureSettled();
  console.log(
    `     after the warm up: ${JSON.stringify({ ...base, documentList: base.documentList.length })}`,
  );

  await rounds(WARMUP, ROUNDS);
  check(
    `${navigations} navigations through ${SEQUENCE.join(', ')}`,
    !failedAt,
    failedAt ? `hangs at ${failedAt}` : `${Math.round((Date.now() - started) / 1000)} s`,
  );

  // Host memory while closing: the highest value, a garbage collection may release a leak again
  const hostBefore = chromiumOnly('host memory while opening and closing (CDP)')
    ? await hostMemory(page)
    : null;
  let hostPeak = hostBefore;
  // Open views or tabs (load the DOM page with an iframe) and close them again
  // A host page that stops answering fails the check instead of ending the test with a timeout
  let tabsFailed = null;
  for (let i = 0; i < TABS && !tabsFailed; i++) {
    try {
      await openTab(`${siteURL}dom?r=tab${i}`);
      if (!(await waitDone(`dom-tab${i}`))) tabsFailed = `page in ${unit} ${i} not loaded`;
      await closeTab();
      if (hostPeak !== null) hostPeak = Math.max(hostPeak, (await hostMemory(page)) ?? 0);
    } catch (error) {
      tabsFailed = `${unit} ${i}: ${error.message.split('\n')[0]}`;
    }
  }
  if (tabsFailed) {
    check(`${TABS} ${unit} opened and closed`, false, tabsFailed);
    return;
  }
  const count = await tabCount();
  check(`${TABS} ${unit} opened and closed`, count === 1, `${count} ${unit} open`);
  // A canvas left to the garbage collector of the engine worker kept about 15 MB per view
  if (hostBefore !== null)
    check(
      `host renderer and GPU process hardly grow with ${TABS} ${unit}`,
      hostPeak - hostBefore < 64 + 4 * TABS,
      `${hostBefore} -> at most ${hostPeak} MB`,
    );

  await go(`${siteURL}empty?r=end`);
  await waitDone('empty-end');
  const end = await measureSettled(base.documents + 2);
  console.log(
    `     at the end: ${JSON.stringify({ ...end, documentList: end.documentList.length })}`,
  );
  const leaked = end.documents > base.documents + 2;
  if (!leaked)
    check('documents back as after the warm up', true, `${base.documents} -> ${end.documents}`);
  else {
    console.log(end.documentList.join('\n'));
    // What in the JS heap keeps them (memory report 4: path to a GC root)
    reportLines.length = 0;
    await page.evaluate(() => window.blTest.memory(4));
    await waitFor(() => reportLines.some((l) => l.includes('marking end')), 120000);
    await page.waitForTimeout(2000);
    console.log(
      reportLines.filter((l) => !/\[memory\] (malloc|  cache|  doc refs)/.test(l)).join('\n'),
    );
    // A few pages now and then stay (status.md: soak tests); a leak grows with more rounds
    await rounds(ROUNDS, 2 * ROUNDS);
    await go(`${siteURL}empty?r=again`);
    await waitDone('empty-again');
    const again = await measureSettled(end.documents + 2);
    check(
      'documents back as after the warm up, or a few that stay and do not grow',
      !failedAt && again.documents <= end.documents + 2,
      `${base.documents} -> ${end.documents} -> ${again.documents} after ${ROUNDS - WARMUP} more rounds`,
    );
  }
  check(
    'malloc uses hardly more',
    end.malloc - base.malloc < 48,
    `${base.malloc} -> ${end.malloc} MB`,
  );
  check('WASM memory hardly grows', end.wasm - base.wasm < 128, `${base.wasm} -> ${end.wasm} MB`);
  check('no media players of the host left', end.players === 0, `${end.players} players`);
}
