// Synchronous XMLHttpRequest (engine/src/SyncLoad.cpp): GET and POST reach the server and return
// status and body, a redirect is followed, cookies go along, the HTTP cache answers a fresh
// entry (persistent storage), cross-origin works with CORS (also with a preflight) and fails without, data: works.
// While the request runs only its page waits like below a dialog (#258): its timers do not run
// inside the waiting script, another view runs its timers. Closing the view during a request that
// never gets an answer ends it, and the watchdog reports no hang.
//
//   node tests/core/sync-xhr-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  hostEvents,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 180000);

const hits = [];
// Requests to /slow and /hang: the time they arrived, and for /hang when its connection closed
const arrived = {};
let hangClosed = false;

// The other origin answers with CORS for /cors (and its preflight), without for /plain
const { url: otherURL } = await serve((req, res) => {
  const path = new URL(req.url, otherURL).pathname;
  hits.push(`other ${req.method} ${path}`);
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'PUT',
    'Access-Control-Allow-Headers': 'X-Test',
  };
  if (path === '/cors' && req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (path === '/cors') return res.writeHead(200, cors).end(`cors-${req.method}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('plain');
});

const SYNC = `
const sync = (method, url, body, headers) => {
  try {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    for (const name in headers ?? {}) x.setRequestHeader(name, headers[name]);
    x.send(body ?? null);
    return x.status + ':' + x.responseText;
  } catch (e) {
    return 'ERR:' + e.name;
  }
};
const report = (name, value) => console.log('RESULT ' + name + '=' + encodeURIComponent(value));
let ticks = 0;
setInterval(() => ticks++, 20);`;

const PAGES = {
  a: `<!doctype html><title>a</title><script>${SYNC}
window.requests = () => setTimeout(() => {
  report('get', sync('GET', '/data'));
  report('post', sync('POST', '/echo', 'a=1'));
  report('redirect', sync('GET', '/redirect'));
  report('cookie', sync('GET', '/cookie'));
  report('cached1', sync('GET', '/cached'));
  report('cors', sync('GET', '${otherURL}cors'));
  report('preflight', sync('PUT', '${otherURL}cors', 'x', { 'X-Test': '1' }));
  report('nocors', sync('GET', '${otherURL}plain'));
  report('data', sync('GET', 'data:text/plain,hi'));
  fetch('/data').then((r) => r.text()).then((t) => report('async', t));
}, 0);
window.slow = () => setTimeout(() => {
  report('cached2', sync('GET', '/cached'));
  const before = ticks;
  report('slow', sync('GET', '/slow'));
  report('slowTicks', ticks - before);
}, 0);
window.hang = () => setTimeout(() => report('hang', sync('GET', '/hang')), 0);
report('aLoaded', 1);</script>`,
  b: `<!doctype html><title>b</title><script>
let n = 0;
setInterval(() => console.log('RESULT bTick=' + n++), 100);
console.log('RESULT bLoaded=1')</script>`,
};

const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, siteURL).pathname;
  hits.push(`${req.method} ${path}`);
  const text = (body, headers = {}) =>
    res.writeHead(200, { 'Content-Type': 'text/plain', ...headers }).end(body);
  if (PAGES[path.slice(1)] !== undefined)
    return res
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'sync=yes; Path=/',
      })
      .end(PAGES[path.slice(1)]);
  if (path === '/data') return text('hello');
  if (path === '/echo') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    return req.on('end', () => text(`${req.method}-${body}`));
  }
  if (path === '/redirect') return res.writeHead(302, { Location: '/data' }).end();
  if (path === '/cookie') return text(req.headers.cookie ?? 'none');
  if (path === '/cached') return text('cached', { 'Cache-Control': 'max-age=600' });
  if (path === '/slow') {
    arrived.slow = Date.now();
    return setTimeout(() => text('slow'), 2000);
  }
  if (path === '/hang') {
    arrived.hang = Date.now();
    req.socket.on('close', () => {
      hangClosed = true;
    });
    return;
  }
  res.writeHead(404).end();
});

const browser = await launch();
const stack = await startStack();
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const results = collect(page);
check(
  'host page started a browser',
  (await openHost(page, stack.app({ url: `${siteURL}a`, persistent: '1' }))) === true,
);
const value = async (name, ms = 30000) => {
  const raw = await results.wait(name, ms);
  return raw === null ? null : decodeURIComponent(raw);
};
const run = (id, source) =>
  page.evaluate(
    ([id, source]) =>
      window.blTest.browser.debug.eval(
        window.blTest.views().find((view) => view.id === id),
        source,
      ),
    [id, source],
  );

check('view A loaded', (await value('aLoaded', 60000)) === '1');
const a = await page.evaluate(() => window.blTest.view().id);

// Requests of every kind
await run(a, 'requests()');
const expect = async (name, expected) => {
  const got = await value(name);
  check(`sync XHR ${name}`, got === expected, `${got} (expected ${expected})`);
};
await expect('get', '200:hello');
await expect('post', '200:POST-a=1');
await expect('redirect', '200:hello');
await expect('cookie', '200:sync=yes');
await expect('cached1', '200:cached');
await expect('cors', '200:cors-GET');
await expect('preflight', '200:cors-PUT');
await expect('nocors', 'ERR:NetworkError');
await expect('data', '200:hi');
await expect('async', 'hello');
const count = (hit) => hits.filter((h) => h === hit).length;
check(
  'the requests reached the servers',
  count('GET /data') >= 2 && count('POST /echo') === 1 && count('other OPTIONS /cors') === 1,
  hits.join(', '),
);

// Only A waits: B runs its timers while A's request is out, A's timers do not run inside
const b = await page.evaluate((url) => window.blTest.open(url).id, `${siteURL}b`);
check('view B loaded', (await value('bLoaded', 30000)) === '1');
await run(a, 'slow()');
check('slow request arrives', await waitFor(() => arrived.slow, 20000));
results.delete('bTick');
const bTicked = await value('bTick', 1500);
check('B runs while A waits for its request', bTicked !== null && !results.has('slow'));
await expect('slow', '200:slow');
await expect('cached2', '200:cached');
check('the fresh entry came from the HTTP cache', count('GET /cached') === 1, hits.join(', '));
await expect('slowTicks', '0');

// Closing A during a request without an answer ends it; B goes on
await run(a, 'hang()');
check('hanging request arrives', await waitFor(() => arrived.hang, 20000));
await page.evaluate(
  (id) =>
    window.blTest
      .views()
      .find((view) => view.id === id)
      .close(),
  a,
);
check('closing A drops its request', await waitFor(() => hangClosed, 10000));
results.delete('bTick');
check('B runs after A closed', (await value('bTick', 5000)) !== null);
check(
  'view B still there',
  await page.evaluate((id) => window.blTest.views().some((view) => view.id === id), b),
);

await page.waitForTimeout(1000);
const events = await hostEvents(page);
check(
  'no unresponsive event and no crash',
  !events.some((event) => event === 'unresponsive' || event.startsWith('crash:')),
  events.filter((event) => event === 'unresponsive' || event.startsWith('crash')).join(),
);

await browser.close();
finish();
