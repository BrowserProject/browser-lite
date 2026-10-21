// Start of the engine (packages/core/src/browser.ts start(), engine.ts): engine.js, engine.wasm
// and engine.data are requested once each, and already while a slow storage.beforeStart runs.
// The pool settings tests/perf measures the start with (BL_POOL_WORKERS before main(), the spare
// workers at BL_SPARE_WORKERS_AT start, ready or paint) take effect and the engine renders with
// each of them, the compositor included. Web Workers are counted by wrapping the Worker
// constructor of the host page.
//
//   node tests/core/start-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>Start</title><body>Start<script>
console.log('RESULT loaded=1');
</script>`;
const { url: pageURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const BEFORE_START_MS = 1500;
const ENGINE_FILES = ['engine.js', 'engine.wasm', 'engine.data'];

const stack = await startStack({ token: 'start-token-0123456789abcdef' });
const browser = await launch();

/**
 * A page in a new context whose Worker constructor records the creation times; mode
 * 'slow-before-start' makes storage.beforeStart take BEFORE_START_MS.
 */
async function newPage(mode) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page);
  await page.addInitScript(
    ({ mode, delay }) => {
      const Native = window.Worker;
      window.workerTimes = [];
      window.Worker = class extends Native {
        constructor(...args) {
          super(...args);
          window.workerTimes.push(performance.now());
        }
      };
      if (mode === 'slow-before-start')
        window.blTestOptions = {
          storage: {
            beforeStart: () =>
              new Promise((resolve) =>
                setTimeout(() => {
                  window.beforeStartDone = performance.now();
                  resolve();
                }, delay),
              ),
          },
        };
    },
    { mode, delay: BEFORE_START_MS },
  );
  return { page, context };
}

/** Times of the steps of the core (bl:<step>) and the Workers created before each. */
const startSteps = (page) =>
  page.evaluate(() => {
    const marks = Object.fromEntries(
      performance
        .getEntriesByType('mark')
        .filter((mark) => mark.name.startsWith('bl:'))
        .map((mark) => [mark.name.slice(3), mark.startTime]),
    );
    const before = (time) => window.workerTimes.filter((t) => t < time).length;
    return {
      marks,
      beforeMain: before(marks.main),
      beforeReady: before(marks.ready),
      workers: window.workerTimes.length,
    };
  });

// Engine files: one request each from the page (the threads load engine.js as their Worker
// script), all of them on the way while beforeStart still runs
{
  const { page, context } = await newPage('slow-before-start');
  const results = collect(page);
  check(
    'persistent browser with a slow beforeStart starts',
    await openHost(page, stack.app({ url: pageURL, persistent: '1' })),
  );
  check('page loaded', (await results.wait('loaded')) === '1');
  const loads = await page.evaluate((names) => {
    const entries = performance.getEntriesByType('resource');
    return Object.fromEntries(
      names.map((name) => {
        // The engine folder of the host page (the core has an engine.js module of its own)
        const all = entries.filter((entry) => new URL(entry.name).pathname === `/engine/${name}`);
        const found = all.filter((entry) => entry.initiatorType !== 'other');
        return [
          name,
          {
            count: found.length,
            start: found[0]?.startTime ?? null,
            initiators: all.map((entry) => `${entry.initiatorType}@${Math.round(entry.startTime)}`),
          },
        ];
      }),
    );
  }, ENGINE_FILES);
  const done = await page.evaluate(() => window.beforeStartDone);
  for (const name of ENGINE_FILES) {
    check(`${name}: one request`, loads[name].count === 1, JSON.stringify(loads[name]));
    check(
      `${name}: requested while beforeStart runs`,
      loads[name].start !== null && loads[name].start < done - BEFORE_START_MS / 2,
      `start ${Math.round(loads[name].start)} ms, beforeStart done ${Math.round(done)} ms`,
    );
  }
  const steps = await startSteps(page);
  check(
    'steps of the start marked',
    ['engine.js', 'engine.data', 'compile', 'beforeStart', 'instantiate', 'main', 'ready'].every(
      (step) => steps.marks[step] > 0,
    ),
    JSON.stringify(steps.marks),
  );
  await context.close();
}

// Pool settings of tests/perf: Workers before main(), the spare ones before ready or later
const variants = [
  { name: 'A (default)', env: '', pool: 8, spareBeforeReady: true },
  {
    name: 'B (3, spare at ready)',
    env: 'BL_POOL_WORKERS=3,BL_SPARE_WORKERS=9,BL_SPARE_WORKERS_AT=ready',
    pool: 3,
    spareBeforeReady: true,
  },
  {
    name: 'D (3, spare at the first paint)',
    env: 'BL_POOL_WORKERS=3,BL_SPARE_WORKERS=9,BL_SPARE_WORKERS_AT=paint',
    pool: 3,
    spareBeforeReady: false,
  },
];
for (const variant of variants) {
  const { page, context } = await newPage(null);
  const results = collect(page);
  check(
    `${variant.name}: starts`,
    await openHost(page, stack.app({ url: pageURL, ...(variant.env ? { env: variant.env } : {}) })),
  );
  check(`${variant.name}: page loaded`, (await results.wait('loaded')) === '1');
  check(
    `${variant.name}: page painted`,
    await page
      .waitForFunction(() => window.blTest.flags.firstPaint, null, { timeout: 60000 })
      .then(
        () => true,
        () => false,
      ),
  );
  // The spare workers load asynchronously on the main thread
  await page
    .waitForFunction(() => window.workerTimes.length >= 12, null, { timeout: 30000 })
    .catch(() => {});
  const steps = await startSteps(page);
  const engine = await page.evaluate(() => window.blTest.measurements());
  check(
    `${variant.name}: ${variant.pool} Workers before main()`,
    steps.beforeMain === variant.pool,
    JSON.stringify(steps),
  );
  check(
    `${variant.name}: spare workers ${variant.spareBeforeReady ? 'before' : 'after'} ready`,
    variant.spareBeforeReady ? steps.beforeReady >= 12 : steps.beforeReady < 12,
    JSON.stringify(steps),
  );
  check(`${variant.name}: 12 Workers in all`, steps.workers === 12, JSON.stringify(steps));
  check(
    `${variant.name}: compositor ready`,
    engine?.compositorReady > 0,
    `threads before ready ${engine?.threadsBeforeReady}, at ${engine?.threadTimes?.map(Math.round)}, compositor ${Math.round(engine?.compositorReady)}, ready ${Math.round(engine?.ready)}`,
  );
  await context.close();
}

await browser.close();
finish();
