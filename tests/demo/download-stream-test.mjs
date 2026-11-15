// Downloads stream into the host browser's downloads (download-sw.js of the core): the host gets
// its download while the file still arrives (the server holds the second half until then), the
// file is complete and intact, and the page does not keep it in memory (Chromium: the renderers
// grow by less than half the file; kept in memory they grew by twice its size). A download cancelled in the host browser ends in the engine,
// so the server sees its connection close.
//
//   node tests/demo/download-stream-test.mjs [engine-dir]
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// A multiple of 251, so every chunk continues the pattern i % 251
const CHUNK = 251 * 4096;
const CHUNKS = 600;
const SIZE = CHUNK * CHUNKS;
const pattern = Buffer.alloc(CHUNK);
for (let i = 0; i < CHUNK; i++) pattern[i] = i % 251;
const PAGE = `<!doctype html><title>Stream</title>
<style>a { position: absolute; left: 20px; font: 24px sans-serif; }</style>
<a href="/big.bin" style="top: 20px">Big</a>
<a href="/endless.bin" style="top: 80px">Endless</a>
<script>console.log('RESULT ready=1')</script>`;

const big = { sent: 0, hash: crypto.createHash('sha256'), release: null, held: false };
const endless = { sent: 0, closed: false };
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  if (req.url === '/big.bin') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(SIZE),
      'Content-Disposition': 'attachment; filename="big.bin"',
    });
    // The first half, then nothing until the host browser has its download (at most 30 s)
    const released = new Promise((resolve) => {
      big.release = resolve;
      setTimeout(resolve, 30000);
    });
    const pump = async () => {
      while (big.sent < SIZE) {
        if (big.sent === SIZE / 2) {
          big.held = true;
          await released;
          big.held = false;
        }
        big.sent += CHUNK;
        big.hash.update(pattern);
        if (!res.write(pattern)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
    };
    void pump();
    return;
  }
  if (req.url === '/endless.bin') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="endless.bin"',
    });
    const timer = setInterval(() => {
      res.write(pattern);
      endless.sent += CHUNK;
    }, 100);
    res.on('close', () => {
      clearInterval(timer);
      endless.closed = true;
    });
    return;
  }
  res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'download-stream-token-0123456789ab' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');
const status = () => page.evaluate(() => document.getElementById('status')?.textContent ?? '');

// Resident memory of the renderers in MB (Chromium on Linux), null elsewhere
const cdp =
  chromiumOnly('renderer memory') && process.platform === 'linux'
    ? await browser.newBrowserCDPSession()
    : null;
async function rendererMemory() {
  if (!cdp) return null;
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  let kB = 0;
  for (const { id, type } of processInfo) {
    if (type !== 'renderer') continue;
    try {
      kB += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${id}/status`, 'utf8'))?.[1] ?? 0);
    } catch {}
  }
  return kB / 1024;
}

const box = await canvasOrigin(page);
const before = await rendererMemory();
let peak = before ?? 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    peak = Math.max(peak, (await rendererMemory()) ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();

const hostDownload = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
const start = Date.now();
await page.mouse.click(box.x + 40, box.y + 34);
const download = await hostDownload;
check(
  'the host browser has the download while the file still arrives',
  !!download && big.sent < SIZE,
  `${(big.sent / 1048576).toFixed(0)} of ${SIZE / 1048576} MB sent, held ${big.held}`,
);
big.release?.();
const file = download ? await download.path().catch(() => null) : null;
await waitFor(async () => /finished|failed/.test(await status()), 120000);
const seconds = (Date.now() - start) / 1000;
sampling = false;
await sampler;
const expected = big.hash.digest('hex');
const actual = file
  ? await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(file)
        .on('data', (data) => hash.update(data))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    })
  : null;
check(
  'the saved file is complete and intact',
  !!file && fs.statSync(file).size === SIZE && actual === expected,
  `${file ? fs.statSync(file).size : 'no file'} of ${SIZE} bytes in ${seconds.toFixed(1)} s`,
);
check(
  'the status line says finished',
  /^Download finished: big\.bin /.test(await status()),
  await status(),
);
if (before !== null) {
  const growth = peak - before;
  check(
    'the page does not hold the file in memory',
    growth < SIZE / 1048576 / 2,
    `renderers ${before.toFixed(0)} MB before, peak ${peak.toFixed(0)} MB (+${growth.toFixed(0)} MB for a ${(SIZE / 1048576).toFixed(0)} MB file)`,
  );
}

// Cancel in the host browser: the engine ends the download and the server its connection
const second = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
await page.mouse.click(box.x + 40, box.y + 94);
const endlessDownload = await second;
check('the endless download reaches the host browser', !!endlessDownload);
await waitFor(() => endless.sent > 4 * CHUNK, 30000);
await endlessDownload?.cancel();
const closed = await waitFor(() => endless.closed, 15000);
check(
  'a cancel in the host browser ends the request at the server',
  closed,
  `${(endless.sent / 1048576).toFixed(0)} MB sent`,
);
const cancelled = await waitFor(
  async () => (await status()) === 'Download cancelled: endless.bin',
  10000,
);
check('the demo shows it as cancelled', cancelled, await status());

await browser.close();
finish();
