// Automatic memory release (engine/src/MemoryWatch.cpp): above BL_MEMORY_RELEASE_MB every growth
// of malloc by 32 MB releases caches like memory pressure, but keeps the compiled JS of the pages
// (patch 0088): functions that ran before the release do not need their bytecode built again. Only
// when memory is short (here the malloc area full above BL_MEMORY_PRESSURE_MB: the page holds what
// malloc grew by) does the release take the code too, and the first calls after it cost as much as the very first ones. The code of pages
// and frames that are gone goes: a view that leaves its page and every release drop JSC's code
// cache, which held the bytecode and the sources of every script evaluated (patch 0102). The
// threshold comes from the host: 512 MB with 8 GB of memory or more, else 192 MB. A release due
// within 3 s of input (or of a navigation of the host) waits until no input came for that long,
// so it does not block the page's answer to a tap or back.
//
//   node tests/core/memory-release-test.mjs [engine-dir]
import {
  canvasOrigin,
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

timeLimit();

// 3000 functions with some code each: their first calls parse them and build their bytecode
const FUNCTIONS = 3000;
const body = (i) =>
  `function f${i}(a) { let s = a + ${i}; for (let k = 0; k < 2; k++) { s = (s * 31 + k) % 1000003; if (s & 1) s += ${i}; else s -= k; } const o = { x: s, y: [s, ${i}], z: 'f${i}' }; return o.x + o.y.length + o.z.length; }`;
const PAGE = `<!doctype html><title>Release</title><body>Release<script>
${Array.from({ length: FUNCTIONS }, (_, i) => body(i)).join('\n')}
const all = [${Array.from({ length: FUNCTIONS }, (_, i) => `f${i}`).join(',')}];
const keep = [];
window.run = (name) => {
  const start = performance.now();
  let sum = 0;
  for (const f of all) sum += f(1);
  console.log('RESULT ' + name + '=' + (performance.now() - start).toFixed(1) + '/' + sum);
};
// Engine memory the page holds: malloc grows, the release follows after this task
window.allocate = (name, mb) => {
  keep.push(new Uint8Array(mb << 20).fill(1));
  console.log('RESULT ' + name + '=ok');
};
// Every press allocates like the answer of a page to a tap
let taps = 0;
addEventListener('pointerdown', () => allocate('tap' + ++taps, 48));
window.drop = (name) => {
  keep.length = 0;
  console.log('RESULT ' + name + '=ok');
};
// Frames with scripts of their own, one after the other, each removed once loaded
window.loadFrames = async (count) => {
  for (let n = 0; n < count; n++) {
    const frame = document.createElement('iframe');
    frame.src = '/left' + (100 + n);
    await new Promise((resolve) => {
      frame.onload = resolve;
      document.body.append(frame);
    });
    frame.remove();
  }
  console.log('RESULT frames=ok');
};
run('cold');
</script>`;
// Pages that are left (and frames): scripts of their own (the code cache keys by the source), not
// kept by the back/forward cache (a device motion listener)
const LEFT_PAGES = 6;
const leftPage = (n) => `<!doctype html><title>Left ${n}</title><body>Left ${n}<script>
addEventListener('devicemotion', () => {});
${Array.from({ length: FUNCTIONS }, (_, i) => body(i).replace(`'f${i}'`, `'p${n}f${i}'`)).join('\n')}
const all = [${Array.from({ length: FUNCTIONS }, (_, i) => `f${i}`).join(',')}];
let sum = 0;
for (let r = 0; r < 20; r++) for (const f of all) sum += f(r);
console.log('RESULT left${n}=' + sum);
</script>`;
const { url: siteURL } = await serve((req, res) => {
  const left = /^\/left(\d+)$/.exec(req.url);
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(left ? leftPage(Number(left[1])) : PAGE);
});

const stack = await startStack();
const browser = await launch();

// A release due within 3 s of input or of a navigation of the host (the load of the page) waits
const QUIET_MS = 3000;
const quiet = (page) => page.waitForTimeout(QUIET_MS + 500);

// Times of the first calls, the next ones and the first ones after an automatic release
async function measure(label, env) {
  const page = await browser.newPage();
  const results = collect(page);
  check(
    `${label}: host page starts`,
    await openHost(page, stack.app({ url: siteURL, log: '1', env })),
  );
  const cold = parseFloat(await results.wait('cold'));
  const run = async (name) => {
    await page.evaluate((name) => window.blTest.eval(`run('${name}')`), name);
    return parseFloat(await results.wait(name));
  };
  const warm = Math.min(await run('warm1'), await run('warm2'));
  await quiet(page);
  const released = () => results.logs.filter((line) => line.includes('Memory released')).length;
  const before = released();
  for (let i = 0; i < 4 && released() === before; i++) {
    await page.evaluate((i) => window.blTest.eval(`allocate('grown${i}', 48)`), i);
    await results.wait(`grown${i}`);
    await page.waitForTimeout(200);
  }
  const lines = results.logs.filter((line) => line.includes('Memory released')).slice(before);
  const after = await run('after');
  await page.close();
  return { cold, warm, after, lines };
}

// The release starts at 64 MB, memory is short only from 4 GB (never here)
const kept = await measure('kept', 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=4096');
check(
  'the first calls cost more than the next ones',
  kept.cold > kept.warm * 3,
  `cold ${kept.cold} ms, warm ${kept.warm} ms`,
);
check(
  'malloc growth releases memory without the JS code',
  kept.lines.length > 0 && !kept.lines.some((line) => line.includes('with the JS code')),
  kept.lines.join(' | '),
);
check(
  'after the release the functions run like before it',
  kept.after <= kept.warm * 2 + 20,
  `cold ${kept.cold} ms, warm ${kept.warm} ms, after the release ${kept.after} ms`,
);

// Above the budget from 64 MB on with the area full: the release deletes the code as under
// memory pressure
const short = await measure('short', 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=64');
check(
  'with memory short the release takes the JS code too',
  short.lines.some((line) => line.includes('with the JS code')),
  short.lines.join(' | '),
);
// Clearly slower than warm (without the release about as fast, at most warm); less than cold,
// the sources stay, and cold varies a lot on a busy machine
check(
  'after it the first calls build the bytecode again',
  short.after > short.warm * 2 + 5,
  `cold ${short.cold} ms, warm ${short.warm} ms, after the release ${short.after} ms`,
);

// Code of what is gone: JSC's code cache held the bytecode and the sources of every script
// evaluated, also of pages left and of frames removed, until a later script pruned it
{
  const page = await browser.newPage();
  const results = collect(page);
  const heaps = [];
  page.on('console', (message) => {
    const heap = /\[memory\] malloc used .* JS heap (\d+) MB/.exec(message.text());
    if (heap) heaps.push(Number(heap[1]));
  });
  // JS heap in MB after a full GC (memory report 2)
  const heapAfterGC = async () => {
    const count = heaps.length;
    await page.evaluate(() => window.blTest.memory(2));
    for (let i = 0; i < 200 && heaps.length === count; i++) await page.waitForTimeout(100);
    return heaps.at(-1);
  };
  check(
    'gone: host page starts',
    await openHost(
      page,
      stack.app({
        url: 'about:blank',
        log: '1',
        env: 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=4096',
      }),
    ),
  );

  // A view that leaves its page drops the code cache, the full GC then takes the page's code
  await load(page, `${siteURL}left0`);
  await results.wait('left0');
  const one = await heapAfterGC();
  for (let n = 1; n <= LEFT_PAGES; n++) {
    await load(page, `${siteURL}left${n}`);
    await results.wait(`left${n}`);
  }
  const left = await heapAfterGC();
  check(
    'gone: pages left take their code with them',
    left < one + LEFT_PAGES,
    `JS heap after a full GC ${one} MB with one page, ${left} MB with one page and ${LEFT_PAGES} left`,
  );

  // Frames that came and went in a page that stays: the release takes their code
  await load(page, siteURL);
  await results.wait('cold');
  await quiet(page);
  const released = () => results.logs.filter((line) => line.includes('Memory released')).length;
  // Grows malloc until it releases, the arrays (which count to the JS heap) go again
  const growUntilRelease = async (name) => {
    const before = released();
    for (let i = 0; i < 4 && released() === before; i++) {
      await page.evaluate((key) => window.blTest.eval(`allocate('${key}', 48)`), `${name}${i}`);
      await results.wait(`${name}${i}`);
      await page.waitForTimeout(200);
    }
    await page.evaluate((key) => window.blTest.eval(`drop('${key}')`), `${name}Dropped`);
    await results.wait(`${name}Dropped`);
    return results.logs.filter((line) => line.includes('Memory released')).slice(before);
  };
  // A release first, so the frames grow malloc into the space it left free: about 34 MB of
  // their code could otherwise cross the next step of 32 MB and release it before it is measured
  await growUntilRelease('room');
  await heapAfterGC();
  await page.evaluate((count) => window.blTest.eval(`loadFrames(${count})`), LEFT_PAGES);
  await results.wait('frames');
  const frames = await heapAfterGC();
  const lines = await growUntilRelease('gone');
  check(
    'gone: the release keeps the JS code of the page',
    lines.length > 0 && !lines.some((line) => line.includes('with the JS code')),
    lines.join(' | '),
  );
  const after = await heapAfterGC();
  check(
    'gone: the release takes the code of the frames that are gone',
    after + LEFT_PAGES < frames,
    `JS heap after a full GC ${frames} MB with ${LEFT_PAGES} frames gone, ${after} MB after the release`,
  );
  await page.close();
}

// The threshold of the host (packages/core/src/config.ts, #633): from 192 MB of malloc area on
// phones (the engine default), from 512 MB on hosts with 8 GB or more, where each release was
// a pause of the engine thread that freed little of what a heavy page still needed. Chromium on
// a desktop reports 8 GB or more, Firefox no device memory; the init script makes it a 4 GB host.
async function releasesWhileGrowing(label, deviceMemory) {
  const page = await browser.newPage();
  if (deviceMemory)
    await page.addInitScript((value) => {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        get: () => value,
        configurable: true,
      });
    }, deviceMemory);
  const results = collect(page);
  check(`${label}: host page starts`, await openHost(page, stack.app({ url: siteURL, log: '1' })));
  await results.wait('cold');
  await quiet(page);
  const reported = await page.evaluate(() => navigator.deviceMemory);
  // 5 x 48 MB above the page: about 300 MB of malloc area, between the two thresholds
  for (let i = 0; i < 5; i++) {
    await page.evaluate((key) => window.blTest.eval(`allocate('${key}', 48)`), `${label}${i}`);
    await results.wait(`${label}${i}`);
    await page.waitForTimeout(200);
  }
  const memory = await page.evaluate(() => window.blTest.browser.debug.memory(0));
  await page.close();
  return {
    reported,
    memoryMB: Math.round(memory / 1048576),
    lines: results.logs.filter((line) => line.includes('Memory released')),
  };
}
const desktop = await releasesWhileGrowing('desktop', 0);
check(
  'a host with plenty of memory does not release below 512 MB',
  desktop.memoryMB > 280 && desktop.lines.length === 0,
  `device memory ${desktop.reported}, engine memory ${desktop.memoryMB} MB, ${desktop.lines.join(' | ')}`,
);
const phone = await releasesWhileGrowing('phone', 4);
check(
  'a host with 4 GB releases from 192 MB like before',
  phone.reported === 4 && phone.lines.length > 0,
  `engine memory ${phone.memoryMB} MB, ${phone.lines.length} releases`,
);

// The release a tap makes due waits until no input came for 3 s (a phone took 0.3 to 0.6 s for one
// inside a tap or back); without input it comes right away
{
  const page = await browser.newPage();
  const results = collect(page);
  const releases = [];
  page.on('console', (message) => {
    if (message.text().includes('Memory released')) releases.push(Date.now());
  });
  check(
    'input: host page starts',
    await openHost(
      page,
      stack.app({
        url: siteURL,
        log: '1',
        env: 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=4096',
      }),
    ),
  );
  await results.wait('cold');
  await quiet(page);
  // Without input: the release follows the growth
  let before = releases.length;
  let start = Date.now();
  await page.evaluate(() => window.blTest.eval(`allocate('quiet', 48)`));
  await results.wait('quiet');
  for (let i = 0; i < 50 && releases.length === before; i++) await page.waitForTimeout(100);
  const withoutInput = releases.length > before ? releases[before] - start : null;
  check(
    'input: without input the release comes at once',
    withoutInput !== null && withoutInput < QUIET_MS - 1000,
    `after ${withoutInput} ms`,
  );
  await quiet(page);
  const origin = await canvasOrigin(page);
  before = releases.length;
  start = Date.now();
  await page.mouse.click(origin.x + 40, origin.y + 40);
  check('input: the press allocates', (await results.wait('tap1')) === 'ok');
  for (let i = 0; i < 100 && releases.length === before; i++) await page.waitForTimeout(100);
  const afterInput = releases.length > before ? releases[before] - start : null;
  check(
    'input: the release a press made due waits until no input came for 3 s',
    afterInput !== null && afterInput >= QUIET_MS - 200 && afterInput < QUIET_MS + 4000,
    `after ${afterInput} ms`,
  );
  check(
    'input: the debug log says how long it waited',
    results.logs.some((line) => /Memory release waited \d+ ms for the user/.test(line)),
  );
  await page.close();
}

await browser.close();
finish();
