// Service workers that do not stop (patches 0111, 0112): a message handler blocks the worker
// thread in an endless loop of WebAssembly, which runs in the host where termination cannot
// interrupt it (like a pattern in the host's RegExp that backtracks without end). The engine
// gives such a worker up 10 s after its termination instead of exiting its process, which
// blocked the engine thread for good with every view dead.
// 1. registration.update() brings a new script that takes over at once (skipWaiting), so the
//    blocked worker is terminated. 1 s later the server's own timer gives up waiting
//    (terminateDueToUnresponsiveness, which once stopped the new worker with a 0 s timeout),
//    10 s later the context's. The engine keeps answering and the new worker answers the page.
// 2. With WebKit's 1 s heartbeat (BL_SW_SHORT_TIMEOUT) a blocked worker whose message event is
//    still extended (waitUntil) fails the heartbeat and is given up; the next message runs the
//    worker again, and its pending events ended with the blocked run, so a new script activates.
//
//   node tests/core/serviceworker-stuck-test.mjs [engine-dir]
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// The page: registers /sw.js, answers 'blocking' with onBlocking(registration)
const page = (
  onBlocking,
) => `<!doctype html><title>Stuck SW</title><body>Stuck service worker<script>
const log = (text) => console.log('RESULT ' + text);
async function replaceWorker(registration) {
  await fetch('/next');
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    log('replaced=1');
    navigator.serviceWorker.controller.postMessage('ping');
  }, { once: true });
  await registration.update();
}
(async () => {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  navigator.serviceWorker.addEventListener('message', (e) => {
    log('message=' + e.data);
    if (e.data === 'blocking') (${onBlocking})(registration);
  });
  navigator.serviceWorker.controller.postMessage('block');
})().catch((e) => log('error=' + e));
</script>`;

// clients.claim() without waitUntil: no event of the worker is still extended when it blocks.
// With extend the message event stays extended and the worker blocks in a task after it, so the
// server knows the pending event (WebKit reports it once the event's dispatch returned).
const blocking = (extend) => `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// (module (func (export "spin") (loop (br 0))))
const SPIN = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4,
  115, 112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11]);
self.addEventListener('message', (e) => {
  if (e.data === 'ping') return e.source.postMessage('pong');
  const { spin } = new WebAssembly.Instance(new WebAssembly.Module(SPIN)).exports;
  const block = () => {
    spin();
    e.source.postMessage('returned');
  };
  e.source.postMessage('blocking');
  ${extend ? 'e.waitUntil(new Promise(() => {})); setTimeout(block, 100);' : 'block();'}
});
`;
const NEXT = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => e.source.postMessage('next-' + e.data));
`;

// A site whose /sw.js is `first` until the page fetched /next
async function site(html, first) {
  let script = first;
  const { url } = await serve((req, res) => {
    if (req.url === '/next') script = NEXT;
    if (req.url === '/sw.js')
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' })
        .end(script);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  return url;
}

const count = (results, text) => results.logs.filter((line) => line.includes(text)).length;

const stack = await startStack();
const browser = await launch();

{
  const url = await site(page('replaceWorker'), blocking(false));
  const tab = await browser.newPage();
  const results = collect(tab);
  await openHost(tab, stack.app({ url }));
  check(
    'update: the worker blocks in WebAssembly',
    (await results.wait('message', 60000)) === 'blocking',
    results.get('error') || '',
  );
  check('update: the new script replaces it', (await results.wait('replaced', 60000)) === '1');
  // Every 2 s a round trip through the engine, before and after the 10 s
  const missed = [];
  const probes = 12;
  for (let i = 0; i < probes; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await evalPage(tab, `console.log('RESULT alive${i}=1')`);
    if ((await results.wait(`alive${i}`, 8000)) !== '1') missed.push(i);
  }
  check(
    'update: the engine keeps answering for 24 s',
    !missed.length,
    `missed ${missed.join(' ')}`,
  );
  const replies = count(results, 'RESULT message=next-ping');
  check('update: the new worker answers the page', replies === 1, String(replies));
  check('update: the blocked worker did not return', !count(results, '=returned'));
  await tab.close();
}

{
  // After 'blocking' a ping every 2 s; the first answer comes from a new run of the worker
  const onBlocking = `(registration) => {
    const ping = setInterval(() => navigator.serviceWorker.controller.postMessage('ping'), 2000);
    navigator.serviceWorker.addEventListener('message', function pong(e) {
      if (e.data !== 'pong') return;
      navigator.serviceWorker.removeEventListener('message', pong);
      clearInterval(ping);
      log('pong=1');
      replaceWorker(registration);
    });
  }`;
  const url = await site(page(onBlocking), blocking(true));
  const tab = await browser.newPage();
  const results = collect(tab);
  await openHost(tab, stack.app({ url, env: 'BL_SW_SHORT_TIMEOUT=1' }));
  check(
    'heartbeat: the worker blocks with an extended event',
    (await results.wait('message', 60000)) === 'blocking',
    results.get('error') || '',
  );
  check('heartbeat: a new run of the worker answers', (await results.wait('pong', 60000)) === '1');
  check(
    'heartbeat: the new script activates after the blocked run',
    (await results.wait('replaced', 30000)) === '1',
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const replies = count(results, 'RESULT message=next-ping');
  check('heartbeat: the new worker answers the page', replies === 1, String(replies));
  check('heartbeat: the blocked worker did not return', !count(results, '=returned'));
  await tab.close();
}

await browser.close();
finish();
