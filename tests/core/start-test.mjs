// Start of the engine (packages/core/src/browser.ts start(), engine.ts): engine.js, engine.wasm
// and engine.data are requested once each, and already while a slow storage.beforeStart runs.
// Right after the start the engine fetches the common lazy files and the ICU data of the user's
// languages in the background (#240).
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
  waitFor,
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

/** A page in a new context whose storage.beforeStart takes BEFORE_START_MS. */
async function newPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page);
  await page.addInitScript((delay) => {
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
  }, BEFORE_START_MS);
  return { page, context };
}

// Engine files: one request each from the page (the threads load engine.js as their Worker
// script), all of them on the way while beforeStart still runs
{
  const { page, context } = await newPage();
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
  await context.close();
}

// Noto Serif before any page needs it, the ICU data of de-CH and de (navigator.languages)
{
  const context = await browser.newContext({ locale: 'de-CH' });
  const page = await context.newPage();
  const requested = new Set();
  context.on('request', (request) => requested.add(new URL(request.url()).pathname));
  check('browser in de-CH starts', await openHost(page, stack.app({ url: pageURL })));
  const ahead = [
    '/engine/lazy/fonts/noto/NotoSerif-Regular.000.ttf',
    '/engine/lazy/icu/icudt78l/de.res',
    '/engine/lazy/icu/icudt78l/curr/de.res',
  ];
  await waitFor(() => ahead.every((path) => requested.has(path)), 15000);
  for (const path of ahead) check(`fetched ahead: ${path}`, requested.has(path));
  await context.close();
}

await browser.close();
finish();
