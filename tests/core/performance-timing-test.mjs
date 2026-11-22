// Navigation timing like Safari: performance.timing has the network phases of the document
// (request and response after the start, in order, responseEnd = responseStart as in WebKit) and
// agrees with the navigation entry; a load on a TLS connection that was already open has
// fetchStart as its secureConnectionStart. Before, every network value of performance.timing was
// navigationStart (the document's response carried no load metrics), which no browser reports.
//
//   node tests/core/performance-timing-test.mjs [engine-dir]
import http2 from 'node:http2';
import path from 'node:path';
import { makeCerts } from '../fixtures/certs.mjs';
import {
  SWIFTSHADER,
  TIMEOUT,
  buildDir,
  check,
  finish,
  launch,
  openHost,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 60000);

const HEADER_DELAY = 300;
const PAGE = `<!doctype html><title>timing</title><p>timing</p>
<script>
addEventListener('load', () => setTimeout(async () => {
  const t = performance.timing.toJSON();
  const n = performance.getEntriesByType('navigation')[0].toJSON();
  await fetch('/second').then((r) => r.text());
  const r = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/second'));
  document.title = 'RESULT ' + JSON.stringify({ t, n, r: r && r.toJSON() });
}, 100));
</script>`;

const certs = makeCerts(path.join(buildDir, 'e2e-certs'));
// HTTP/2: the fetch after the load goes over the connection of the page
const server = http2.createSecureServer({ ...certs.good, allowHTTP1: true }, (req, res) => {
  if (req.url === '/second') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write(PAGE.slice(0, 40));
    setTimeout(() => res.end(PAGE.slice(40)), 100);
  }, HEADER_DELAY);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `https://127.0.0.1:${server.address().port}/page`;

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.addInitScript((pem) => {
  window.blTestOptions = { engine: { extraCA: pem } };
}, certs.ca);
watchErrors(page, '[chromium error]');
check('host page starts the browser', await openHost(page, stack.app({ url })));

const title = () => page.evaluate(() => window.blTest.view()?.title ?? '');
await waitFor(async () => (await title()).startsWith('RESULT '), TIMEOUT, 200);
const text = await title();
check('page reported its timing', text.startsWith('RESULT '), text);
const { t, n, r } = JSON.parse(text.slice(7) || '{}');
const at = (name) => (t?.[name] ? t[name] - t.navigationStart : -1);
console.log(
  'performance.timing after navigationStart:',
  [
    'fetchStart',
    'connectStart',
    'connectEnd',
    'requestStart',
    'responseStart',
    'responseEnd',
    'domLoading',
  ]
    .map((name) => `${name} ${at(name)}`)
    .join(', '),
);
const order = [
  'fetchStart',
  'domainLookupStart',
  'domainLookupEnd',
  'connectStart',
  'connectEnd',
  'requestStart',
  'responseStart',
  'responseEnd',
  'domLoading',
];
check(
  'network phases in order from navigationStart',
  order.every((name, i) => at(name) >= 0 && (i === 0 || at(name) >= at(order[i - 1]))),
  order.map((name) => `${name}=${at(name)}`).join(' '),
);
check(
  `responseStart after the server's ${HEADER_DELAY} ms`,
  at('responseStart') >= HEADER_DELAY - 20 && at('responseStart') > at('requestStart'),
  `requestStart ${at('requestStart')}, responseStart ${at('responseStart')}`,
);
check(
  'responseEnd equals responseStart like WebKit',
  at('responseEnd') === at('responseStart'),
  `${at('responseEnd')}`,
);
check(
  'performance.timing agrees with the navigation entry',
  n &&
    Math.abs(at('responseStart') - n.responseStart) <= 2 &&
    Math.abs(at('requestStart') - n.requestStart) <= 2,
  `entry requestStart ${n?.requestStart}, responseStart ${n?.responseStart}`,
);
check(
  'a load on the open TLS connection has fetchStart as secureConnectionStart',
  r &&
    r.nextHopProtocol === 'h2' &&
    r.secureConnectionStart > 0 &&
    r.secureConnectionStart === r.fetchStart,
  `${r?.nextHopProtocol}, fetchStart ${r?.fetchStart}, secureConnectionStart ${r?.secureConnectionStart}`,
);

await browser.close();
server.close();
finish();
