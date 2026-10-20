// Memory limit found at runtime (engine/src/MemoryWatch.cpp): with a test limit (debug.memoryLimit,
// malloc fails there like at the limit of a 32 bit browser) the engine reports memory-pressure
// with footprint and limit while every allocation still succeeds, then at every further growth;
// beyond the limit the page gets a RangeError and the engine keeps running. Without the limit the
// memory grows on without an event.
//
//   node tests/core/memory-test.mjs [engine-dir]
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

const MB = 2 ** 20;
// The smallest limit measured in i386 Chromium (a second memory next to the engine's)
const LIMIT_MB = 640;
const STEP_MB = 16;

const PAGE = `<!doctype html><title>Memory</title><body>Memory<script>
const keep = [];
let step = 0;
// Allocations in the engine memory, one engine task per call; on failure the page lets go of
// everything it holds
window.allocate = (mb) => {
  step++;
  try {
    keep.push(new Uint8Array(mb << 20).fill(1));
    console.log('RESULT allocated' + step + '=ok');
  } catch (error) {
    keep.length = 0;
    console.log('RESULT allocated' + step + '=' + error.name);
  }
};
console.log('RESULT loaded=1');
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'memory-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: siteURL })));
check('page loaded', (await results.wait('loaded')) === '1');

const events = () => page.evaluate(() => window.blHost.memoryPressure);
const memoryMB = async () => Math.round((await page.evaluate(() => window.blTest.memory())) / MB);
let allocations = 0;
// Allocates STEP_MB in the page: 'ok', the name of the error, or null when it did not answer
async function allocate() {
  allocations++;
  await page.evaluate((mb) => window.blTest.eval(`allocate(${mb})`), STEP_MB);
  return results.wait(`allocated${allocations}`, 20000);
}

const startMB = await memoryMB();
await page.evaluate((mb) => window.blTest.memoryLimit(mb), LIMIT_MB);
check(
  'no memory-pressure while there is room below the limit',
  (await allocate()) === 'ok' && (await events()).length === 0,
  `memory ${startMB} MB, limit ${LIMIT_MB} MB`,
);

let result = 'ok';
for (let i = 0; i < 40 && result === 'ok' && !(await events()).length; i++)
  result = await allocate();
const [first] = await events();
check(
  'memory-pressure with footprint and limit',
  !!first && first.limit === LIMIT_MB * MB && first.footprint > 256 * MB,
  JSON.stringify(first),
);
const roomMB = first ? (first.limit - first.footprint) / MB : 0;
check(
  'memory-pressure comes while every allocation still succeeds, with room left',
  result === 'ok' && roomMB >= 64 && roomMB <= 256,
  `${roomMB.toFixed(0)} MB left after ${allocations * STEP_MB} MB, last allocation ${result}`,
);

// Near the limit: an event at every further growth by 32 MB
const before = (await events()).length;
for (let i = 0; i < 3 && result === 'ok'; i++) result = await allocate();
await page.waitForTimeout(500);
const after = (await events()).length;
check('memory-pressure again at every growth', after >= before + 1, `${before} -> ${after}`);

// The limit is real: beyond it the allocation fails cleanly
for (let i = 0; i < 20 && result === 'ok'; i++) result = await allocate();
check(
  'beyond the limit malloc fails: RangeError in the page',
  result === 'RangeError',
  `${result} after ${allocations * STEP_MB} MB`,
);

// Back to the real limit: the memory grows on, no further event
await page.evaluate(() => window.blTest.memoryLimit(0));
await page.waitForTimeout(500);
const withoutLimit = (await events()).length;
for (let i = 0; i < 6 && result; i++) result = await allocate();
await page.waitForTimeout(500);
check(
  'without the test limit no further event',
  (await events()).length === withoutLimit,
  `${withoutLimit} -> ${(await events()).length}, memory ${await memoryMB()} MB`,
);
check('the page still answers', result === 'ok', result);
check(
  'engine did not crash',
  !(await page.evaluate(() => window.blHost.events.some((e) => e.startsWith('crash')))),
);

// The debug event carries the same fields
await page.evaluate(() => window.blTest.memoryPressure());
const simulated = (await events()).at(-1);
check(
  'debug memoryPressure() with footprint and limit',
  simulated?.footprint > 0 && simulated.footprint === simulated.limit,
  JSON.stringify(simulated),
);

await browser.close();
finish();
