// The downloads panel (Ctrl+J) during a running download: its row counts the received bytes as
// they arrive, a Cancel button stops the download (the server sees the connection end before the
// file is through), the row then reads "Cancelled", offers "Retry" and the host browser's download
// of it fails; a finished download is complete in the host browser and offers "Download again"
// (its file streamed there, the demo keeps none). Like Chrome the list outlives "Restart now" (a
// reload of the demo), "Download again" loads the address once more and the page stays, "Clear
// all" empties the list for good.
//
//   node tests/demo/downloads-test.mjs [engine-dir]
import fs from 'node:fs';
import {
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
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
let smallRequests = 0;
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  else if (req.url === '/small.txt' && ++smallRequests)
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
// The downloads of the host browser: they start with the download in the demo (streamed)
const hostFiles = [];
const hostFile = (name) => hostFiles.find((download) => download.suggestedFilename() === name);
let page;
let results;
/** The demo in a new tab of the host browser. */
async function openDemo() {
  page = await context.newPage();
  watchErrors(page);
  results = collect(page);
  page.on('download', (download) => hostFiles.push(download));
  await page.goto(stack.app({ url: siteURL }));
  return (await results.wait('ready', TIMEOUT)) === '1';
}
check('page ready', await openDemo());

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
const rowButtons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#side-panel .panel-download')].map(
      (row) =>
        `${row.querySelector('.panel-title')?.textContent}|${row.querySelector('.panel-url')?.textContent}|${[...row.querySelectorAll('button')].map((b) => b.textContent).join(',')}`,
    ),
  );
check(
  'a cancelled download offers Retry',
  JSON.stringify(await rowButtons()) === JSON.stringify(['slow.bin|Cancelled|Retry']),
  JSON.stringify(await rowButtons()),
);
// Playwright reports no failure of an interrupted download in Firefox, also not of a server's
if (chromiumOnly('host download failure')) {
  const slowFailure = await hostFile('slow.bin')?.failure();
  check('the host browser download of it failed', !!slowFailure, String(slowFailure));
}

// The demo starts again in a new tab (in Firefox Playwright's input reaches no page of a tab after
// one of its downloads was interrupted, also one a server broke off): the list is still there
await page.close();
check('page ready after a restart in a new tab', await openDemo());
await page.keyboard.press('Control+j');
await page.waitForSelector('#side-panel .panel-download', { timeout: 10000 }).catch(() => {});
check(
  'the list outlives the restart',
  JSON.stringify(await rowButtons()) === JSON.stringify(['slow.bin|Cancelled|Retry']),
  JSON.stringify(await rowButtons()),
);

// A finished download next to it is complete in the host browser (the panel stays open)
await page.keyboard.press('Control+j');
await page.mouse.click(box.x + 40, box.y + 94);
await waitFor(() => !!hostFile('small.txt'), 30000);
const smallPath = await hostFile('small.txt')
  ?.path()
  .catch(() => null);
check(
  'the finished download is complete in the host browser',
  !!smallPath && fs.readFileSync(smallPath, 'utf8') === 'small file\n',
);
await page.keyboard.press('Control+j');
const finishedRow = async () => (await rowButtons()).includes('small.txt|11 B|Download again');
check(
  'the finished download offers Download again',
  await waitFor(finishedRow, 10000),
  JSON.stringify(await rowButtons()),
);

// Restart now (settings) marks the restart and reloads the demo: the list must come back
results.delete('ready');
await page.evaluate(() => sessionStorage.setItem('bl-restart', '1'));
await page.reload();
check('page ready after the restart', (await results.wait('ready', TIMEOUT)) === '1');
await page.keyboard.press('Control+j');
await page.waitForSelector('#side-panel .panel-download', { timeout: 10000 }).catch(() => {});
check(
  'the list outlives a restart, without the files',
  JSON.stringify(await rowButtons()) ===
    JSON.stringify(['small.txt|11 B|Download again', 'slow.bin|Cancelled|Retry']),
  JSON.stringify(await rowButtons()),
);

// Download again requests the address once more; the answer is a file, so the page stays
const requestsBefore = smallRequests;
const hostBefore = hostFiles.length;
await page
  .locator('#side-panel .panel-download button', { hasText: 'Download again' })
  .click()
  .catch(() => {});
await waitFor(() => hostFiles.length === hostBefore + 1, 30000);
check(
  'Download again requests the file once more and saves it',
  hostFiles.length === hostBefore + 1 && smallRequests === requestsBefore + 1,
  `${hostFiles.length - hostBefore} saved, ${smallRequests - requestsBefore} requests`,
);
const tabTitle = await page.evaluate(
  () => document.querySelector('#tab-list .tab.active .title')?.textContent,
);
check('the page stays after Download again', tabTitle === 'Downloads', String(tabTitle));
// The open panel follows the change
await waitFor(async () => (await rowButtons()).length === 3, 10000);
check(
  'the new download is listed on top',
  (await rowButtons())[0] === 'small.txt|11 B|Download again' && (await rowButtons()).length === 3,
  JSON.stringify(await rowButtons()),
);

// Clear all empties the list, also for the next start
await page.locator('#side-panel > .panel-action', { hasText: 'Clear all' }).click();
const emptied = await waitFor(
  () => page.evaluate(() => !!document.querySelector('#side-panel .panel-empty')),
  5000,
);
check('Clear all empties the list', emptied && (await rowButtons()).length === 0);
results.delete('ready');
await page.evaluate(() => sessionStorage.setItem('bl-restart', '1'));
await page.reload();
await results.wait('ready', TIMEOUT);
await page.keyboard.press('Control+j');
await page.waitForSelector('#side-panel .panel-empty', { timeout: 10000 }).catch(() => {});
check('the cleared list stays empty after a restart', (await rowButtons()).length === 0);

await browser.close();
finish();
