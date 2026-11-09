// The downloads panel (Ctrl+J) during a running download: its row counts the received bytes as
// they arrive, a Cancel button stops the download (the server sees the connection end before the
// file is through), the row then reads "Cancelled" and nothing goes to the host browser; a
// finished download offers "Save again".
//
//   node tests/demo/downloads-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const SIZE = 20 * 1024 * 1024;
const CHUNK = 64 * 1024;
const PAGE = `<!doctype html><title>Downloads</title>
<style>a { position: absolute; left: 20px; font: 24px sans-serif; }</style>
<a id="slow" href="/slow.bin" style="top: 20px">Slow</a>
<a id="small" href="/small.txt" style="top: 80px">Small</a>
<script>console.log('RESULT ready=1')</script>`;

// The slow file: 64 KB every 50 ms (about 1.3 MB/s), so 20 MB would take 16 s
const slow = { started: false, ended: false, aborted: false, sent: 0 };
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  else if (req.url === '/small.txt')
    res
      .writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="small.txt"',
      })
      .end('small file\n');
  else if (req.url === '/slow.bin') {
    slow.started = true;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(SIZE),
      'Content-Disposition': 'attachment; filename="slow.bin"',
    });
    const timer = setInterval(() => {
      res.write(Buffer.alloc(CHUNK, 7));
      slow.sent += CHUNK;
      if (slow.sent >= SIZE) {
        clearInterval(timer);
        res.end();
        slow.ended = true;
      }
    }, 50);
    res.on('close', () => {
      clearInterval(timer);
      if (!slow.ended) slow.aborted = true;
    });
  } else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'downloads-token-0123456789abcdef' });
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
let hostDownloads = 0;
page.on('download', () => hostDownloads++);

const box = await canvasOrigin(page);
await page.mouse.click(box.x + 40, box.y + 34);
await waitFor(() => slow.sent > 4 * CHUNK, 30000);
check('slow download started', slow.started && slow.sent > 0, `${slow.sent} bytes sent`);

// Ctrl+J opens the panel; its row must follow the download while the panel stays open
await page.keyboard.press('Control+j');
const rowText = () =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll('#side-panel .panel-download')].find(
      (r) => r.querySelector('.panel-title')?.textContent === 'slow.bin',
    );
    return row?.querySelector('.panel-url')?.textContent ?? null;
  });
await page.waitForSelector('#side-panel .panel-download', { timeout: 10000 });
const first = await rowText();
const shown = new Set([first]);
const moved = await waitFor(async () => {
  shown.add(await rowText());
  return shown.size >= 3;
}, 15000);
check(
  'the panel row counts the received bytes while it is open',
  moved && / of 20\.0 MB$/.test(first ?? ''),
  [...shown].join(' | '),
);
const bar = await page.evaluate(() => {
  const progress = document.querySelector('#side-panel .panel-download progress');
  return progress ? [progress.value, progress.max] : null;
});
check(
  'the row has a progress bar',
  !!bar && bar[1] === 20 * 1024 * 1024 && bar[0] > 0 && bar[0] < bar[1],
  JSON.stringify(bar),
);

await screenshot(page, 'downloads-panel');

// Cancel stops it in the engine: the server sees the connection end before the file is through
const cancel = page.locator('#side-panel .panel-download button', { hasText: 'Cancel' });
check('a running download has a Cancel button', (await cancel.count()) === 1);
if ((await cancel.count()) === 1) await cancel.click();
const aborted = await waitFor(() => slow.aborted, 15000);
check(
  'Cancel ends the request at the server',
  aborted && !slow.ended,
  `${(slow.sent / 1024 / 1024).toFixed(1)} MB sent`,
);
const cancelled = await waitFor(async () => (await rowText()) === 'Cancelled', 5000);
check('the row reads Cancelled', cancelled, String(await rowText()));
const status = await page.evaluate(() => document.getElementById('status').textContent);
check('the status line says it was cancelled', status === 'Download cancelled: slow.bin', status);
check(
  'a cancelled download has no buttons',
  (await page.locator('#side-panel .panel-download button').count()) === 0,
);

// A finished download next to it offers Save again (the panel stays open over the page)
await page.keyboard.press('Control+j');
await page.mouse.click(box.x + 40, box.y + 94);
await waitFor(() => hostDownloads === 1, 30000);
await page.keyboard.press('Control+j');
const saveAgain = page.locator('#side-panel .panel-download button', { hasText: 'Save again' });
await saveAgain.waitFor({ timeout: 10000 }).catch(() => {});
check(
  'only the finished download went to the host browser and offers Save again',
  hostDownloads === 1 && (await saveAgain.count()) === 1,
  `${hostDownloads} host downloads`,
);

await browser.close();
finish();
