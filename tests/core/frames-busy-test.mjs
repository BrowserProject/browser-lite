// Rendering while the page keeps the engine thread busy with many short tasks (#359): the
// compositor's answer for the last rendering update is urgent work (engine/src/EngineLoop.cpp),
// taken in between two tasks of the page, so the page gets a frame every task or two. Before,
// the answer waited behind all of the page's queued tasks and the page got one frame per batch.
//
//   node tests/core/frames-busy-test.mjs [engine-dir]
import {
  SWIFTSHADER,
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

const TASKS = 40;
const TASK_MS = 100;
// A layer that moves every frame, so every rendering update goes through the compositor. run()
// queues TASKS messages at once, each a task that blocks for TASK_MS, and reports the gaps between
// the animation frames meanwhile, longest first.
const PAGE = `<!doctype html><title>Frames while busy</title>
<style>body { margin: 0 } #mover { width: 50px; height: 50px; background: rgb(255, 0, 0); will-change: transform }</style>
<div id="mover"></div>
<script>
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
let frames = 0, last = 0, gaps = null;
const tick = (now) => {
  document.getElementById('mover').style.transform = 'translateX(' + (frames++ % 300) + 'px)';
  if (gaps && last) gaps.push(now - last);
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
window.run = () => {
  gaps = [];
  last = 0;
  let done = 0;
  const channel = new MessageChannel();
  channel.port2.onmessage = () => {
    busy(${TASK_MS});
    if (++done < ${TASKS}) return;
    // The frame after the last task closes its gap
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sorted = gaps.sort((a, b) => b - a).map(Math.round);
      gaps = null;
      console.log('RESULT gaps=' + sorted.length + ':' + sorted.slice(0, 5).join(','));
    }));
  };
  for (let i = 0; i < ${TASKS}; i++) channel.port1.postMessage(i);
};
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const lost = [];
page.on('console', (message) => {
  if (/answer got lost/.test(message.text())) lost.push(message.text());
});
const results = collect(page);
check('page loaded', await openHost(page, stack.app({ url: siteURL, compositing: '1', log: '1' })));
await results.wait('ready');
await page.waitForTimeout(2000);
await page.evaluate(() => window.blTest.eval('run()'));
const gaps = await results.wait('gaps', 60000);
const [count, longest] = (gaps || '0:').split(':');
const second = Number(longest.split(',')[1] ?? Number.POSITIVE_INFINITY);
// Ideally a frame per task; the second longest gap leaves room for one outlier (a GC). Before
// the change the page got a frame every 6 to 8 tasks.
check(
  `a frame at least every 4 of the page's busy tasks (${TASK_MS} ms each)`,
  Number(count) >= TASKS / 4 && second <= 4 * TASK_MS,
  `${count} frames, longest gaps ${longest} ms`,
);
check('no compositor answer counted as lost', lost.length === 0, lost.join(' | '));
await browser.close();
finish();
