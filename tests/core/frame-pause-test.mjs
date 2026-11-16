// A long script of a cross-site frame pauses for the user (engine/src/FramePause.cpp): all frames
// share the engine thread, and keys to a page whose cross-site frame ran tasks of seconds (an
// anti-bot challenge like Cloudflare's Turnstile) waited for each task. Now the keys of the page
// run within milliseconds and its rendering goes on, while the frame's task pauses with its
// locals intact. Input that reaches the paused frame (a click into it) and the frame's resize
// observer wait for its task instead of running inside it or being dropped; the frame's script
// is stopped when the page removes the frame meanwhile; a frame of the same site (one event loop
// with the page) does not pause, its keys wait as before.
//
//   node tests/core/frame-pause-test.mjs [engine-dir]
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

const TASK_MS = 3000;

// The page: a field at the top left, the frame below it; keys report their time, whether their
// stack shows the frame's functions and how many animation frames the page had. Key r widens the
// frame, key x removes it.
const mainPage = (frame) => `<!doctype html><title>main</title><body style="margin:0">
<input style="position:absolute;left:10px;top:10px;width:300px;height:30px">
<iframe src="${frame}" style="position:absolute;left:10px;top:80px;width:300px;height:200px;border:0"></iframe>
<script>
let frames = 0;
const tick = () => { frames++; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
document.querySelector('input').onkeydown = (e) => {
  const stack = new Error().stack.includes('frameTaskStep') ? 'frame' : 'own';
  console.log('RESULT keydown=' + e.key + ':' + Date.now() + ':' + stack + ':' + frames);
  if (e.key === 'r') document.querySelector('iframe').style.width = '320px';
  if (e.key === 'x') document.querySelector('iframe').remove();
};
console.log('RESULT loaded=main');
</script>`;

// Tasks of TASK_MS back to back, each calling functions five levels deep that check their
// argument and local after their calls. Each task reports its number, start, end, the longest gap
// between two of its steps and the broken locals; a mousedown and the resize observer report
// whether a task was running.
const framePage = `<!doctype html><title>frame</title><body style="margin:0;background:#ddd">frame<script>
let end = 0, last = 0, gap = 0, broken = 0, running = false, task = 0;
function frameTaskStep() { const now = Date.now(); gap = Math.max(gap, now - last); last = now; return now < end; }
const level = (next) => (a) => {
  if (!frameTaskStep()) return a;
  const k = a * 3 + 1;
  ${'next(k);'.repeat(30)}
  if (k !== a * 3 + 1 || a !== (k - 1) / 3) broken++;
  return k % 1000;
};
let calls = frameTaskStep;
for (let i = 0; i < 5; i++) calls = level(calls);
const channel = new MessageChannel();
channel.port1.onmessage = () => {
  const start = Date.now();
  end = start + ${TASK_MS}; last = start; gap = 0; broken = 0; running = true; task++;
  console.log('RESULT taskstart=' + task + ':' + start);
  while (Date.now() < end) calls(1);
  running = false;
  console.log('RESULT task=' + task + ':' + start + ':' + Date.now() + ':' + gap + ':' + broken);
  channel.port2.postMessage(0);
};
document.onmousedown = () => console.log('RESULT framedown=' + running + ':' + Date.now());
let observed = 0;
new ResizeObserver(() => { if (observed++) console.log('RESULT resized=' + running + ':' + Date.now()); }).observe(document.documentElement);
channel.port2.postMessage(0);
</script>`;

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const page =
    url.pathname === '/main'
      ? mainPage(url.searchParams.get('frame'))
      : url.pathname === '/frame'
        ? framePage
        : null;
  if (!page) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(page);
};
const { url: siteURL } = await serve(handler);
const port = new URL(siteURL).port;
// localhost is another site than 127.0.0.1: WebKit gives the frame an event loop of its own
const crossSiteFrame = `http://localhost:${port}/frame`;
// Another port of 127.0.0.1: another origin of the same site, one event loop with the page
const { url: otherPortURL } = await serve(handler);

const stack = await startStack();
const browser = await launch();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// All RESULT lines of key, in order: [value, ...]
const all = (results, key) =>
  results.logs.flatMap((line) => {
    const match = new RegExp(`RESULT ${key}=(\\S*)`).exec(line);
    return match ? [match[1]] : [];
  });

async function openPage(frame) {
  const tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const results = collect(tab);
  check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
  await load(tab, `${siteURL}main?frame=${encodeURIComponent(frame)}`);
  check('the page loads', (await results.wait('loaded', 30000)) === 'main');
  check('the frame runs its tasks', !!(await results.wait('task', 30000)));
  return { tab, results, origin: await canvasOrigin(tab) };
}

// Waits until a task of the frame started 300 ms ago; returns its number
async function inFrameTask(results) {
  const seen = all(results, 'taskstart').length;
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(20)) {
    const starts = all(results, 'taskstart');
    if (starts.length > seen) {
      await sleep(300);
      return Number(starts.at(-1).split(':')[0]);
    }
  }
  return null;
}

// The task's report: { start, end, gap, broken }, after it ended
async function taskReport(results, number) {
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(100)) {
    const found = all(results, 'task').find((value) => Number(value.split(':')[0]) === number);
    if (found) {
      const [, start, stop, gap, broken] = found.split(':').map(Number);
      return { start, end: stop, gap, broken };
    }
  }
  return null;
}

// Keys into the field during one task of the frame: their latencies (ms) and reports
async function typeDuringTask(page, keys) {
  const task = await inFrameTask(page.results);
  const before = all(page.results, 'keydown').length;
  const sent = [];
  for (const key of keys) {
    sent.push(Date.now());
    await page.tab.keyboard.press(key);
    await sleep(150);
  }
  for (
    const end = Date.now() + 20000;
    Date.now() < end && all(page.results, 'keydown').length < before + keys.length;
  )
    await sleep(100);
  const downs = all(page.results, 'keydown')
    .slice(before)
    .map((value) => value.split(':'));
  return {
    task,
    latencies: downs.map((down, i) => Number(down[1]) - sent[i]),
    stacks: downs.map((down) => down[2]),
    frames: downs.map((down) => Number(down[3])),
  };
}

// A frame of another site: the page answers during the frame's tasks
{
  const page = await openPage(crossSiteFrame);
  await page.tab.mouse.click(page.origin.x + 100, page.origin.y + 25);
  const typed = await typeDuringTask(page, ['a', 'b', 'c', 'd', 'e', 'f']);
  const worst = Math.max(...typed.latencies);
  check(
    'cross-site frame: keys to the page during a task of 3 s of the frame wait under 500 ms',
    typed.latencies.length === 6 && worst < 500,
    `latencies ${typed.latencies.join(', ')} ms`,
  );
  check(
    'cross-site frame: the key handlers see no frame of the paused script',
    typed.stacks.every((s) => s === 'own'),
    typed.stacks.join(','),
  );
  check(
    'cross-site frame: the page renders meanwhile (animation frames between the keys)',
    typed.frames.at(-1) > typed.frames[0],
    `animation frames ${typed.frames.join(', ')}`,
  );
  const report = await taskReport(page.results, typed.task);
  check(
    'cross-site frame: its task paused while the user typed and went on with intact locals',
    report && report.gap >= 400 && report.broken === 0,
    JSON.stringify(report),
  );

  // A click into the frame during its task waits for the task and is not dropped
  const clickTask = await inFrameTask(page.results);
  await page.tab.mouse.click(page.origin.x + 100, page.origin.y + 150);
  const down = await page.results.wait('framedown', 20000);
  const clickReport = await taskReport(page.results, clickTask);
  check(
    'cross-site frame: a click into it during its task arrives right after the task',
    down?.startsWith('false:') &&
      clickReport &&
      Number(down.split(':')[1]) >= clickReport.end &&
      Number(down.split(':')[1]) - clickReport.end < 500,
    `framedown ${down}, task ${JSON.stringify(clickReport)}`,
  );

  // The page resizes the frame during its task: the frame's observer runs after the task
  await page.tab.mouse.click(page.origin.x + 100, page.origin.y + 25);
  await inFrameTask(page.results);
  await page.tab.keyboard.press('r');
  const resized = await page.results.wait('resized', 20000);
  check(
    'cross-site frame: its resize observer runs after its task, not inside it',
    resized?.startsWith('false:'),
    `resized ${resized}`,
  );

  // The page removes the frame during its task: the frame's script stops, the engine is free
  const removedTask = await inFrameTask(page.results);
  await page.tab.keyboard.press('x');
  await sleep(1000);
  const before = all(page.results, 'keydown').length;
  const sent = Date.now();
  await page.tab.keyboard.press('y');
  for (
    const end = Date.now() + 20000;
    Date.now() < end && all(page.results, 'keydown').length <= before;
  )
    await sleep(50);
  const latency = Number(all(page.results, 'keydown')[before]?.split(':')[1]) - sent;
  await sleep(TASK_MS);
  const removedReport = all(page.results, 'task').find(
    (value) => Number(value.split(':')[0]) === removedTask,
  );
  check(
    'cross-site frame: removed during its task, its script stops and the page answers',
    !removedReport && latency < 500,
    `report of the task ${removedReport}, next key ${latency} ms`,
  );
  await page.tab.close();
}

// A frame of the same site shares the page's event loop: it does not pause, keys wait
{
  const page = await openPage(`${otherPortURL}frame`);
  await page.tab.mouse.click(page.origin.x + 100, page.origin.y + 25);
  const typed = await typeDuringTask(page, ['a']);
  check(
    'same-site frame: the key waits for its task (one event loop, no pause)',
    typed.latencies[0] > 1500,
    `latency ${typed.latencies[0]} ms`,
  );
  await page.tab.close();
}

await browser.close();

finish();
