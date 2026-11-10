// A closed view's garbage goes soon (engine/src/MemoryWatch.cpp, viewClosed): once no view closed
// for a moment, a full GC collects its documents and everything its scripts built. JSC alone
// learns of that garbage only at its next full collection: without allocations its timer waits
// for a time that grows with the length of the last full GC and shrinks with the share it freed,
// minutes after a GC that freed little (10 heavy tabs closed kept 240 MB of JS heap and 60
// documents for 4 minutes). Here the full GC before the close frees nothing, so its timer alone
// would wait for good.
//
//   node tests/core/closed-view-gc-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// About 100 MB of JS objects and some DOM, held by the page until its view closes
const HEAVY = `<!doctype html><title>Heavy</title><body>Heavy<script>
const keep = [];
for (let i = 0; i < 600000; i++) keep.push({ n: i, list: [i, i + 1], name: 'item ' + i });
for (let i = 0; i < 2000; i++) document.body.append(document.createElement('p'));
console.log('RESULT heavy=loaded');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(HEAVY);
});

const stack = await startStack();
const browser = await launch();
const tab = await browser.newPage();
const results = collect(tab);
const reports = [];
tab.on('console', (message) => {
  const report =
    /\[memory\] malloc used \d+ MB, free \d+ MB, JS heap (\d+) MB .* documents (\d+)/.exec(
      message.text(),
    );
  if (report) reports.push({ heap: Number(report[1]), documents: Number(report[2]) });
});

// The memory report, after a full GC (level 1) or as it is (level 0)
async function memory(level) {
  const count = reports.length;
  await tab.evaluate((report) => window.blTest.memory(report), level);
  for (let i = 0; i < 100 && reports.length === count; i++) await tab.waitForTimeout(100);
  return reports.at(-1);
}

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
await tab.waitForTimeout(1000);
const base = await memory(1);

await tab.evaluate((url) => window.blTest.open(url), `${siteURL}heavy`);
check('heavy page loaded', (await results.wait('heavy')) === 'loaded');
// The last full GC before the close frees nothing
const heavy = await memory(1);
check(
  'heavy page holds its JS heap',
  heavy.heap >= base.heap + 50 && heavy.documents > base.documents,
  `JS heap ${base.heap} -> ${heavy.heap} MB, documents ${base.documents} -> ${heavy.documents}`,
);

await tab.evaluate(() => window.blTest.views().at(-1).close());
const closedAt = Date.now();
let after = await memory(0);
while (
  Date.now() - closedAt < 15000 &&
  (after.heap > base.heap + 20 || after.documents > base.documents)
) {
  await tab.waitForTimeout(1000);
  after = await memory(0);
}
check(
  'the garbage of a closed view goes without a forced GC',
  after.heap <= base.heap + 20 && after.documents <= base.documents,
  `JS heap ${heavy.heap} -> ${after.heap} MB, documents ${heavy.documents} -> ${after.documents} ` +
    `${((Date.now() - closedAt) / 1000).toFixed(1)} s after the close`,
);

await browser.close();
finish();
