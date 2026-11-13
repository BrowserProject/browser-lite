// AbortSignals of a closed view let its document go (patch 0128, JSAbortSignalCustom.cpp): a
// signal that may still abort (a timeout with an abort listener, AbortSignal.any of live signals,
// the signal of a Request that follows another one) kept its wrapper, its listeners and through
// their closures the whole document alive for good once its context had stopped, where nothing can
// abort it any more (booking.com: about 150 MB and its frames after the tab closed). While the page
// lives such signals still stay to fire their listeners.
//
//   node tests/core/abort-signal-gc-test.mjs [engine-dir]
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

// Ways of keeping a signal that can still abort, each with an abort listener whose closure holds
// the document and about 50 MB of JS objects
const KINDS = {
  timeout: 'const signal = AbortSignal.timeout(3600000);',
  any: 'const controller = new AbortController(); const signal = AbortSignal.any([controller.signal]);',
  follow:
    "const controller = new AbortController(); const signal = new Request('/x', { signal: controller.signal }).signal;",
};

const page = (kind) => `<!doctype html><title>${kind}</title><body>${kind}<script>
const keep = [];
for (let i = 0; i < 300000; i++) keep.push({ n: i, name: 'item ' + i });
for (let i = 0; i < 1000; i++) document.body.append(document.createElement('p'));
(() => {
  ${KINDS[kind]}
  signal.addEventListener('abort', () => console.log(document.title, keep.length, typeof controller));
})();
console.log('RESULT ${kind}=loaded');
</script>`;

// Signals without any reference from the page fire their listeners after a full GC: the test
// runs one right after the load, the timeout and the abort of the controller come later
const LIVE = `<!doctype html><title>live</title><body>live<script>
const controller = new AbortController();
(() => {
  AbortSignal.timeout(2000).addEventListener('abort', () => console.log('RESULT timeoutLive=fired'));
  AbortSignal.any([controller.signal]).addEventListener('abort', () => console.log('RESULT anyLive=fired'));
  new Request('/x', { signal: controller.signal }).signal
    .addEventListener('abort', () => console.log('RESULT followLive=fired'));
})();
setTimeout(() => controller.abort(), 2000);
console.log('RESULT live=loaded');
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const kind = req.url.slice(1);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(kind === 'live' ? LIVE : page(kind));
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

// The memory report after a full GC
async function memory() {
  const count = reports.length;
  await tab.evaluate(() => window.blTest.memory(1));
  for (let i = 0; i < 100 && reports.length === count; i++) await tab.waitForTimeout(100);
  return reports.at(-1);
}

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
await tab.waitForTimeout(1000);
const base = await memory();

for (const kind of Object.keys(KINDS)) {
  await tab.evaluate((url) => window.blTest.open(url), `${siteURL}${kind}`);
  check(`${kind} page loaded`, (await results.wait(kind)) === 'loaded');
  const open = await memory();
  await tab.evaluate(() => window.blTest.views().at(-1).close());
  await tab.waitForTimeout(500);
  const closed = await memory();
  check(
    `${kind}: a signal with an abort listener lets the closed page go`,
    closed.documents <= base.documents && closed.heap <= base.heap + 15,
    `documents ${base.documents} -> ${open.documents} -> ${closed.documents}, ` +
      `JS heap ${base.heap} -> ${open.heap} -> ${closed.heap} MB`,
  );
}

await tab.evaluate((url) => window.blTest.open(url), `${siteURL}live`);
check('live page loaded', (await results.wait('live')) === 'loaded');
await memory();
for (const kind of Object.keys(KINDS)) {
  check(
    `${kind}: a signal of a live page fires its listener after a full GC`,
    (await results.wait(`${kind}Live`, 10000)) === 'fired',
  );
}

await browser.close();
finish();
