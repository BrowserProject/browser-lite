// Automatic memory release (engine/src/MemoryWatch.cpp): above BL_MEMORY_RELEASE_MB every growth
// of malloc by 32 MB releases caches like memory pressure, but keeps the compiled JS of the pages
// (patch 0088): functions that ran before the release do not need their bytecode built again. Only
// when memory is short (here BL_MEMORY_PRESSURE_MB below the footprint) does the release take the
// code too, and the first calls after it cost as much as the very first ones.
//
//   node tests/core/memory-release-test.mjs [engine-dir]
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
run('cold');
</script>`;
const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

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

// Memory short from 64 MB on: the release deletes the code as under memory pressure
const short = await measure('short', 'BL_MEMORY_RELEASE_MB=64,BL_MEMORY_PRESSURE_MB=64');
check(
  'with memory short the release takes the JS code too',
  short.lines.some((line) => line.includes('with the JS code')),
  short.lines.join(' | '),
);
check(
  'after it the first calls build the bytecode again',
  short.after > short.warm * 3 + 20,
  `cold ${short.cold} ms, warm ${short.warm} ms, after the release ${short.after} ms`,
);

await browser.close();
finish();
