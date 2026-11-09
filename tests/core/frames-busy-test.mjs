// Rendering while the page keeps the engine thread busy with many short tasks (#359): the
// compositor's answer for the last rendering update is urgent work (engine/src/EngineLoop.cpp),
// taken in between two tasks of the page, so the page gets a frame every task or two. Before,
// the answer waited behind all of the page's queued tasks and the page got one frame per batch.
// The same while a worker of the page posts messages all the time (each one wakes the engine's
// RunLoop from the worker's thread, like the network and the ad workers of a news page) and every
// task also starts a timer: a pass of the engine's local tasks once ran several RunLoop pumps
// queued meanwhile back to back, and the host's frame waited for all of them (a gap of 4 tasks and
// more, on blick.ch up to 2.6 s). Now at most one pump waits (#477).
// Also the stall diagnostic of a view the host gives no frames: its compositor never ran, so
// the log tells the time since the view started (before: seconds since the clock's epoch).
//
//   node tests/core/frames-busy-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  openHost,
  openView,
  serve,
  startStack,
  timeLimit,
  waitFor,
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
window.runWithWakeups = () => {
  gaps = [];
  last = 0;
  const worker = new Worker(URL.createObjectURL(new Blob([
    'const t = setInterval(() => { for (let i = 0; i < 5; i++) postMessage(i); }, 2); onmessage = () => clearInterval(t);',
  ])));
  worker.onmessage = () => {};
  let done = 0;
  const channel = new MessageChannel();
  channel.port2.onmessage = () => {
    busy(${TASK_MS});
    if (++done < ${TASKS}) {
      setTimeout(() => busy(2), 0);
      channel.port1.postMessage(0);
      return;
    }
    worker.terminate();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sorted = gaps.sort((a, b) => b - a).map(Math.round);
      gaps = null;
      console.log('RESULT wakeups=' + sorted.length + ':' + sorted.slice(0, 8).join(','));
    }));
  };
  channel.port1.postMessage(0);
};
console.log('RESULT ready=1');
</script>`;
const { url: siteURL } = await serve((req, res) => {
  // Never answers: the page stays empty, no first paint
  if (req.url === '/hang') return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(page);
const lost = [];
const stalls = [];
page.on('console', (message) => {
  const text = message.text();
  if (/answer got lost/.test(text)) lost.push(text);
  if (/no rendering update for/.test(text)) stalls.push(text);
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

await page.evaluate(() => window.blTest.eval('runWithWakeups()'));
const wakeups = await results.wait('wakeups', 60000);
const wakeupGaps = (wakeups || '0:').split(':')[1].split(',').map(Number);
// Before the change 5 to 6 gaps of 2 to 4 tasks; one outlier allowed (a GC)
check(
  `with a worker waking the engine: at most one gap over 2 of the page's tasks (${TASK_MS} ms each)`,
  wakeups && wakeupGaps.filter((gap) => gap > 2 * TASK_MS).length <= 1,
  `${wakeups?.split(':')[0]} frames, longest gaps ${wakeupGaps.join(',')} ms`,
);
check('no compositor answer counted as lost', lost.length === 0, lost.join(' | '));

// The host drops its display refresh callbacks and the page never arrives (no early first
// paint): a new view requests frames and gets none, its compositor never runs. After two stall
// checks (2 s apart) the engine logs where the view stands.
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;
});
const started = Date.now();
const stalledView = await openView(page, new URL('/hang', siteURL).href);
const pattern = new RegExp(
  `View ${stalledView}: no rendering update for .*compositor phase (\\d+) for (-?\\d+) s`,
);
const stallLine = () => stalls.map((text) => text.match(pattern)).find(Boolean);
await waitFor(stallLine, 30000);
const stall = stallLine();
const since = Math.round((Date.now() - started) / 1000);
check(
  "stall log of a view whose compositor never ran: idle for the view's lifetime",
  stall && stall[1] === '0' && Number(stall[2]) >= 0 && Number(stall[2]) <= since + 1,
  stall ? `${stall.input} (view open ${since} s)` : `no stall log: ${stalls.join(' | ')}`,
);
await browser.close();
finish();
