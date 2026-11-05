// A page that is left goes away completely, also when microtasks of it still wait. Here the body of
// a fetch never ends: leaving the page cancels the load, the stream's error handling queues
// microtasks of the page, and in the back/forward cache they wait. The site's event loop never runs
// again after it was left, and its microtask queue is a GC root: before patch 0077 the waiting
// microtasks kept the window and its document for good once the cache dropped the page, through
// every memory release (spiegel.de kept 27,000 nodes and 4.5 MB of cache this way). A page the
// back/forward cache does not take (it listens to device motion) goes the same way.
//
//   node tests/core/page-left-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const page = (extra) => `<!doctype html><title>left</title><div id="list"></div><script>
for (let i = 0; i < 2000; i++) list.append(document.createElement('p'));
${extra}
fetch('/endless').then(async (response) => {
  const reader = response.body.getReader();
  while (!(await reader.read()).done);
}).catch(() => {});
fetch('/endless').then((response) => response.text()).catch(() => {});
console.log('RESULT ' + location.pathname.slice(1) + '=loaded');
</script>`;
const open = [];
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/endless') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.write('x'.repeat(1000));
    open.push(res);
    return;
  }
  const html = {
    '/cached': page(''),
    '/sensor': page("addEventListener('devicemotion', () => {});"),
  }[path];
  if (!html) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});

const stack = await startStack({ token: 'page-left-token-0123456789abcdef' });
const browser = await launch();
const tab = await browser.newPage();
const results = collect(tab);
const reports = [];
tab.on('console', (message) => {
  const documents = /\[memory\] malloc used .* documents (\d+)/.exec(message.text());
  if (documents) reports.push(Number(documents[1]));
});

// Documents after releasing everything releasable and a full GC (memory report 3)
async function documents() {
  const count = reports.length;
  await tab.evaluate(() => window.blTest.memory(3));
  for (let i = 0; i < 100 && reports.length === count; i++) await tab.waitForTimeout(100);
  return reports.at(-1);
}

// The discarded microtasks leave in a task of the left site's event loop: a few reports
async function documentsAfterLeaving(limit) {
  let count = await documents();
  for (let i = 0; i < 5 && count > limit; i++) {
    await tab.waitForTimeout(1000);
    count = await documents();
  }
  return count;
}

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
await tab.waitForTimeout(1000);
const base = await documents();

for (const [name, path] of [
  ['in the back/forward cache', '/cached'],
  ['not in the back/forward cache', '/sensor'],
]) {
  await load(tab, `${siteURL}${path.slice(1)}`);
  check(`page ${name} loaded`, (await results.wait(path.slice(1))) === 'loaded');
  await tab.waitForTimeout(500);
  await load(tab, 'about:blank');
  await tab.waitForTimeout(1000);
  const count = await documentsAfterLeaving(base);
  check(
    `a page left ${name} while its microtasks wait goes away`,
    count === base,
    `documents ${base} before, ${count} after`,
  );
}

await browser.close();
for (const res of open) res.destroy();
finish();
