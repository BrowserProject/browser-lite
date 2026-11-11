// A tab whose only navigation became a download does not stay as an empty tab, like Chrome and
// Firefox: a target=_blank link, a popup that goes to the file and a Ctrl click on the link close
// their tab again, the opener is in front and Ctrl+Shift+T brings nothing back. A new tab page
// stays the new tab page when its typed address is a file ("New tab", empty address bar), a tab
// with a page keeps it, and the only tab shows the new tab page.
//
//   node tests/demo/download-tabs-test.mjs [engine-dir]
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

const PAGE = `<!doctype html><title>Opener</title>
<style>body { margin: 0 } a, button { position: absolute; left: 20px; font: 24px sans-serif; }</style>
<a id="link" href="/file.csv" target="_blank" style="top: 20px">csv</a>
<button id="popup" style="top: 80px" onclick="const w = window.open(); w.location = '/file.csv'">popup</button>
<a id="plain" href="/file.csv" style="top: 140px">plain</a>
<script>console.log('RESULT ready=1')</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else if (req.url === '/file.csv')
    res
      .writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="data.csv"',
      })
      .end('a,b\n1,2\n');
  else if (req.url === '/doc.pdf')
    res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF-1.4\n%%EOF\n');
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'download-tabs-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
let saved = 0;
page.on('download', () => saved++);
await page.goto(stack.app({ url: siteURL }));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');

const state = () =>
  page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#tab-list .tab')].map(
      (tab) =>
        (tab.classList.contains('active') ? '*' : '') + tab.querySelector('.title')?.textContent,
    ),
    address: document.getElementById('address').value,
    newTabPage: !document.getElementById('new-tab-page').hidden,
  }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The file reached the host browser and the tabs settled on the expected strip
async function settled(downloads, tabs) {
  await waitFor(() => saved === downloads, 30000);
  await waitFor(async () => same((await state()).tabs, tabs), 5000);
  // A tab that would stay is still there a moment later
  await page.waitForTimeout(500);
  return state();
}

const box = await canvasOrigin(page);
await page.mouse.click(box.x + 40, box.y + 34);
let s = await settled(1, ['*Opener']);
check(
  'a target=_blank link to a file leaves no tab, the opener is in front',
  saved === 1 && same(s.tabs, ['*Opener']) && !s.newTabPage,
  JSON.stringify({ saved, ...s }),
);
await screenshot(page, 'download-tabs-link');

await page.mouse.click(box.x + 60, box.y + 96);
s = await settled(2, ['*Opener']);
check(
  'a popup that goes to a file leaves no tab',
  saved === 2 && same(s.tabs, ['*Opener']),
  JSON.stringify({ saved, ...s }),
);

await page.keyboard.down('Control');
await page.mouse.click(box.x + 40, box.y + 34);
await page.keyboard.up('Control');
s = await settled(3, ['*Opener']);
check(
  'a Ctrl click on the link leaves no background tab',
  saved === 3 && same(s.tabs, ['*Opener']),
  JSON.stringify({ saved, ...s }),
);

await page.keyboard.press('Control+Shift+t');
await page.waitForTimeout(1000);
s = await state();
check('Ctrl+Shift+T brings none of them back', same(s.tabs, ['*Opener']), JSON.stringify(s));

// A link in the tab itself: the page stays
await page.mouse.click(box.x + 40, box.y + 154);
s = await settled(4, ['*Opener']);
check(
  'a file from a link of the page keeps the page',
  saved === 4 && same(s.tabs, ['*Opener']) && s.address === siteURL,
  JSON.stringify({ saved, ...s }),
);

// A typed file address on the new tab page: the new tab page stays
await page.keyboard.press('Control+t');
await page.waitForFunction(() => document.activeElement === document.getElementById('address'));
await page.keyboard.type(`${siteURL}doc.pdf`);
await page.keyboard.press('Enter');
s = await settled(5, ['Opener', '*New tab']);
check(
  'a typed file address keeps the new tab page with an empty address bar',
  saved === 5 && same(s.tabs, ['Opener', '*New tab']) && s.newTabPage && s.address === '',
  JSON.stringify({ saved, ...s }),
);
await screenshot(page, 'download-tabs-new-tab-page');

// The only tab: the new tab page instead of an empty page
const fresh = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
const only = await fresh.newPage();
watchErrors(only);
only.on('download', () => saved++);
await only.goto(stack.app({ url: `${siteURL}file.csv` }));
await waitFor(() => saved === 6, TIMEOUT);
await only.waitForTimeout(1000);
const alone = await only.evaluate(() => ({
  tabs: [...document.querySelectorAll('#tab-list .tab .title')].map((t) => t.textContent),
  newTabPage: !document.getElementById('new-tab-page').hidden,
  address: document.getElementById('address').value,
}));
check(
  'the only tab shows the new tab page after its download',
  saved === 6 && same(alone.tabs, ['New tab']) && alone.newTabPage && alone.address === '',
  JSON.stringify(alone),
);

await browser.close();
finish();
