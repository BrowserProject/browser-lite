// Engine workers whose engine.js does not load (engine/js/workers.js, blWatchWorkerLoads):
// Firefox fails most of several workers that load the same cached engine.js at once (the pool at
// the start, a refill of the reserve). Such a worker is replaced: the start goes on, a thread that
// had taken it runs in the replacement, and when engine.js never loads into a worker the start
// fails with an error instead of waiting forever.
// The failed loads are made here: worker requests of engine.js are aborted.
//
//   node tests/core/worker-load-test.mjs [engine-dir]
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

// Threads of the page: every Worker of the page runs in an engine thread
const PAGE_WORKERS = 6;
const PAGES = {
  '/': `<!doctype html><title>Workers</title><body>Workers<script>
console.log('RESULT loaded=1');
</script>`,
  '/threads': `<!doctype html><title>Threads</title><body>Threads<script>
let answered = 0;
for (let i = 0; i < ${PAGE_WORKERS}; i++)
  new Worker('/worker.js').onmessage = () => {
    if (++answered === ${PAGE_WORKERS}) console.log('RESULT answered=' + answered);
  };
</script>`,
  '/worker.js': 'postMessage(1);',
};
const { url: siteURL } = await serve((req, res) => {
  const type = req.url.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type }).end(PAGES[req.url] ?? '');
});
// Start or failure, long before the test's own limit (before the fix the start waited forever)
const START_WITHIN_MS = 30000;
const POOL_WORKERS = 8;

const stack = await startStack({ token: 'worker-load-token-0123456789abcdef' });
const browser = await launch();

/**
 * A page whose worker requests of engine.js fail after the first `skip`, `failing` of them. The
 * page's own <script> request goes through: Firefox marks the worker requests (Sec-Fetch-Dest),
 * Chromium shows no such header to the route, there the core's request comes first and the
 * workers' after it. `env` goes to the engine. Resolves the page, its context and the counts of
 * worker requests.
 */
async function pageWithFailingWorkers({ skip = 0, failing, env = {} }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((env) => {
    window.blTestOptions = { engine: { env } };
  }, env);
  const requests = { all: 0, workers: 0, failed: 0 };
  const warnings = [];
  page.on('console', (message) => {
    if (message.text().includes('[workers]')) warnings.push(message.text());
  });
  await context.route(/\/engine\/engine\.js$/, async (route) => {
    const request = route.request();
    const destination = (await request.allHeaders())['sec-fetch-dest'];
    const first = requests.all++ === 0;
    if (destination ? destination !== 'worker' : first) return route.continue();
    if (++requests.workers <= skip || requests.failed >= failing) return route.continue();
    requests.failed++;
    return route.abort('failed');
  });
  return { page, context, requests, warnings };
}

/** blHost.ready (true: started, false: failed), or 'waiting' after START_WITHIN_MS. */
const startWithin = (page, path = '/') =>
  Promise.race([
    openHost(page, stack.app({ url: siteURL + path.slice(1) })),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), START_WITHIN_MS)),
  ]);

const replaced = (warnings) => warnings.filter((text) => text.includes('did not load')).length;

// The first 5 worker loads fail: the pool of 8 starts 5 replacements, the start goes on
{
  const { page, context, requests, warnings } = await pageWithFailingWorkers({ failing: 5 });
  const results = collect(page);
  const ready = await startWithin(page);
  check('starts although 5 workers did not load', ready === true, String(ready));
  check('page loaded', ready === true && (await results.wait('loaded')) === '1');
  check('5 worker loads failed', requests.failed === 5, JSON.stringify(requests));
  check('each failed worker was replaced', replaced(warnings) === 5, warnings.join('\n'));
  await context.close();
}

// Without spare workers a new thread takes a worker that is still loading: the first 2 of those
// fail, their threads run in the replacements and the page's workers answer
{
  const { page, context, requests, warnings } = await pageWithFailingWorkers({
    skip: POOL_WORKERS,
    failing: 2,
    env: { BL_SPARE_WORKERS: '0' },
  });
  const results = collect(page);
  const ready = await startWithin(page, '/threads');
  check('starts without spare workers', ready === true, String(ready));
  check(
    `page with ${PAGE_WORKERS} workers: all answer`,
    ready === true && (await results.wait('answered')) === String(PAGE_WORKERS),
  );
  check('2 worker loads of threads failed', requests.failed === 2, JSON.stringify(requests));
  check('both were replaced', replaced(warnings) === 2, warnings.join('\n'));
  await context.close();
}

// No worker load succeeds: the start fails with an error
{
  const { page, context, requests } = await pageWithFailingWorkers({
    failing: Number.POSITIVE_INFINITY,
  });
  const started = performance.now();
  const ready = await startWithin(page);
  const ms = Math.round(performance.now() - started);
  check('start fails instead of waiting', ready === false, `${ready} after ${ms} ms`);
  const error = await page.evaluate(() => window.blHost.error);
  check(
    'start error names the worker load',
    error?.code === 'engine-load-failed' && /engine\.js did not load/.test(error.message),
    JSON.stringify(error),
  );
  // At most 3 tries for each of the 8 places of the pool (BL_WORKER_LOAD_TRIES)
  check(
    'gave up after a few tries',
    requests.workers <= 3 * POOL_WORKERS,
    JSON.stringify(requests),
  );
  await context.close();
}

await browser.close();
finish();
