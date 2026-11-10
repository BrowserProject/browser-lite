// Automatic memory release (engine/src/MemoryWatch.cpp): above BL_MEMORY_RELEASE_MB every growth
// of malloc by 32 MB releases caches like memory pressure, but keeps the compiled JS of the pages
// (patch 0088): functions that ran before the release do not need their bytecode built again. Only
// when memory is short (here the malloc area full above BL_MEMORY_PRESSURE_MB: the page holds what
// malloc grew by) does the release take the code too, and the first calls after it cost as much as the very first ones. The code of pages
// and frames that are gone goes: a view that leaves its page and every release drop JSC's code
// cache, which held the bytecode and the sources of every script evaluated (patch 0102).
//
//   node tests/core/memory-release-test.mjs [engine-dir]
import {
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
// Clearly slower than warm (without the release about as fast); less than cold, the sources
// stay, and cold varies a lot on a busy machine
check(
  'after it the first calls build the bytecode again',
  short.after > short.warm * 3 + 5,
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

await browser.close();
finish();
