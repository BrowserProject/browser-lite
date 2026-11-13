// Background views through @browser-lite/core (WebView::setVisible, View.setVisible): hidden pages
// see visibilityState 'hidden', rAF and CSS animations stop, setInterval runs at most about once
// per second, the engine does not paint; with sound, sound and timers go on. While the user types
// in the front view (also through pauses while the focus stays in the field), the front view
// loads a page or a view was just shown (until its first frame), a busy hidden view waits, also
// its restyles, relayouts and load events. With
// and without the compositor. Also memory pressure (the engine reports "memory-pressure"), the watchdog after an
// input (unresponsive, responsive; the engine stops a script only once input waited its limit,
// keepWaiting() gives the script the limit again) and no hang during a long native dialog of the host page, a
// muted video in the picture-in-picture window keeps running hidden, so do a srcObject stream and
// muted sound. Hidden, a video without an audio track pauses (in the host too), a muted one with
// an audio track goes on.
//
//   node tests/core/background-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  VERBOSE,
  canvasOrigin,
  check,
  finish,
  hostEvents,
  launch,
  load,
  openView,
  recordClip,
  selectView,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitEvent,
  waitFor,
  watchErrors,
  wav,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 300000);

const TONE = wav(60, { amplitude: 4000 });

// Counts rAF while hidden and a timer (10 ms); hiding and showing report what ran in between
// (the first frame after showing may come before the queued visibilitychange event). The CSS
// animation runs with layers in the compositor.
const VISIBILITY_SCRIPT = `
let raf = 0, ticks = 0, mark = null;
const loop = () => { if (document.hidden) raf++; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
setInterval(() => ticks++, 10);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    mark = { raf, ticks, time: performance.now() };
    console.log('RESULT hidden=' + document.visibilityState);
    return;
  }
  const seconds = (performance.now() - mark.time) / 1000;
  console.log('RESULT shown=' + JSON.stringify({ state: document.visibilityState, raf: raf - mark.raf,
    ticksPerSecond: Math.round((ticks - mark.ticks) / seconds), seconds: Math.round(seconds * 10) / 10 }));
});
`;
const PAGES = {
  moving: `<!doctype html><title>moving</title><style>body{margin:0;background:#fff}
#box{position:absolute;left:0;top:0;width:100px;height:100px;background:#e00;animation:move 0.6s linear infinite alternate;will-change:transform}
@keyframes move{to{transform:translateX(400px)}}</style><div id="box"></div>
<script>${VISIBILITY_SCRIPT}console.log('RESULT loaded=' + document.visibilityState)</script>`,
  sound: `<!doctype html><title>sound</title><audio src="/tone.wav" loop></audio>
<script>${VISIBILITY_SCRIPT}console.log('RESULT loaded=' + document.visibilityState)</script>`,
  empty:
    '<!doctype html><title>empty</title><p>empty<script>console.log("RESULT loaded=empty")</script>',
  // Loop in mousedown: blocks the engine thread until the watchdog stops it
  stuck: `<!doctype html><title>stuck</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.body.onmousedown = () => { if (location.hash === '#go') for (;;); };
addEventListener('pagehide', () => console.log('RESULT gone=stuck'));
console.log('RESULT loaded=stuck')</script>`,
  // alert from keydown, then some more work
  dialog: `<!doctype html><title>dialog</title><body style="margin:0"><div style="width:400px;height:300px;background:#cde"></div>
<script>document.onkeydown = (e) => { if (e.key !== 'a') return; alert('hello'); const end = Date.now() + 300; while (Date.now() < end); console.log('RESULT alerted=1'); };
console.log('RESULT loaded=dialog')</script>`,
  // A muted video (without an audio track), a click sends it into the PiP window
  pip: `<!doctype html><title>pip</title><body style="margin:0"><video src="/clip.webm" muted loop autoplay playsinline style="display:block;width:400px;height:300px"></video>
<script>const video = document.querySelector('video');
video.onplaying = () => console.log('RESULT playing=' + document.visibilityState);
video.onpause = () => console.log('RESULT pause=' + document.visibilityState);
document.onclick = () => video.requestPictureInPicture().then(() => console.log('RESULT pip=ok'), (e) => console.log('RESULT pip=' + e.name));
document.addEventListener('visibilitychange', () => console.log('RESULT state=' + document.visibilityState));
console.log('RESULT loaded=pip')</script>`,
  // Muted, but no pure video: a srcObject stream (like a video conference) and muted sound
  stream: `<!doctype html><title>stream</title><canvas width="64" height="64"></canvas><video muted playsinline></video><audio src="/tone.wav" muted loop></audio>
<script>const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
let frame = 0;
setInterval(() => { context.fillStyle = frame++ % 2 ? '#f00' : '#00f'; context.fillRect(0, 0, 64, 64); }, 100);
const video = document.querySelector('video');
const audio = document.querySelector('audio');
video.srcObject = canvas.captureStream(10);
video.onpause = () => console.log('RESULT pause=video');
audio.onpause = () => console.log('RESULT pause=audio');
Promise.all([video.play(), audio.play()]).then(() => console.log('RESULT playing=stream'), (e) => console.log('RESULT playing=' + e.name));
document.addEventListener('visibilitychange', () => console.log('RESULT state=' + document.visibilityState + ':' + video.paused + ':' + audio.paused));
</script>`,
  // Muted autoplay: a video without an audio track and one with
  videos: `<!doctype html><title>videos</title><video id="silent" src="/clip.webm" muted loop autoplay playsinline width="160" height="120"></video>
<video id="sound" src="/sound-clip.webm" muted loop autoplay playsinline width="160" height="120"></video>
<script>const videos = [...document.querySelectorAll('video')];
for (const video of videos) {
  video.onplaying = () => console.log('RESULT playing=' + video.id);
  video.onpause = () => console.log('RESULT pause=' + video.id);
}
document.addEventListener('visibilitychange', () => console.log('RESULT state=' + document.visibilityState + ':' + videos.map((v) => v.paused).join(':')));
console.log('RESULT loaded=videos')</script>`,
  // Long tasks one after the other (not throttled like timers), for typing in another view
  busy: `<!doctype html><title>busy</title><p>busy<script>const channel = new MessageChannel();
channel.port1.onmessage = () => { const end = Date.now() + 500; while (Date.now() < end); console.log('RESULT chunk=' + Date.now()); channel.port2.postMessage(0); };
channel.port2.postMessage(0);
console.log('RESULT loaded=busy')</script>`,
  // Four tasks of 250 ms queued at once, like the many callbacks of a heavy page loading; the
  // engine runs them in one pass unless urgent work waits
  batches: `<!doctype html><title>batches</title><p>batches<script>const channel = new MessageChannel();
let left = 0;
channel.port1.onmessage = () => {
  const start = Date.now();
  while (Date.now() < start + 250);
  console.log('RESULT task=' + start + ':' + Date.now());
  if (--left <= 0) { left = 4; for (let i = 0; i < 4; i++) channel.port2.postMessage(0); }
};
channel.port2.postMessage(0);
console.log('RESULT loaded=batches')</script>`,
  // Busy itself (tasks of 100 ms, four at a time) and changes while hidden, so a frame is due
  // when it is shown again; the first rAF after that (in the first rendering update) reports when
  // it ran
  shown: `<!doctype html><title>shown</title><p id="n">0</p><script>let n = 0;
setInterval(() => { document.getElementById('n').textContent = ++n; }, 200);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) requestAnimationFrame(() => console.log('RESULT frame=' + Date.now()));
});
const channel = new MessageChannel();
let left = 0;
channel.port1.onmessage = () => {
  const start = Date.now();
  while (Date.now() < start + 100);
  console.log('RESULT own=' + start + ':' + Date.now());
  if (--left <= 0) { left = 4; for (let i = 0; i < 4; i++) channel.port2.postMessage(0); }
};
channel.port2.postMessage(0);
console.log('RESULT loaded=shown')</script>`,
  // Tasks of 1.5 s that each leave a restyle and a relayout of a long text for the timers of
  // style and layout and a load event of an image from the memory cache (not tasks of the page)
  // whose handler asks for the layout, so input mostly comes while they are due; the cost of one
  // restyle and relayout is measured
  restyle: `<!doctype html><title>restyle</title><style>body.wide p{width:320px;font-size:15px}</style><body>
<script>const text = 'lorem ipsum dolor sit amet consectetur '.repeat(6);
document.body.append(...Array.from({ length: 6000 }, () => Object.assign(document.createElement('p'), { textContent: text })));
document.body.offsetHeight;
const start = performance.now();
document.body.classList.toggle('wide');
document.body.offsetHeight;
console.log('RESULT restyle=' + Math.round(performance.now() - start));
const channel = new MessageChannel();
const sources = ['#e00', '#00e'].map((color) => {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 300, 150);
  return canvas.toDataURL();
});
let preloaded = 0;
for (const source of sources) {
  const preload = new Image();
  preload.onload = () => { if (++preloaded === sources.length) channel.port2.postMessage(0); };
  preload.src = source;
}
const image = new Image();
image.onload = () => {
  document.body.offsetHeight;
  console.log('RESULT imageload=' + Date.now());
};
let turn = 0;
channel.port1.onmessage = () => {
  const end = Date.now() + 1500;
  while (Date.now() < end);
  document.body.classList.toggle('wide');
  image.src = sources[turn++ % 2];
  channel.port2.postMessage(0);
};
console.log('RESULT loaded=restyle')</script>`,
  typing: `<!doctype html><title>typing</title><body style="margin:0"><input style="position:absolute;left:10px;top:10px;width:300px;height:30px">
<script>document.querySelector('input').onkeydown = (e) => console.log('RESULT keydown=' + e.key + ':' + Date.now());
document.onmousedown = () => console.log('RESULT mousedown=' + Date.now());
console.log('RESULT loaded=typing')</script>`,
  // For memory pressure: reports when the view goes away
  memory: `<!doctype html><title>memory</title><p>memory<script>const name = location.search.slice(1);
addEventListener('pagehide', () => console.log('RESULT gone=' + name));
console.log('RESULT loaded=' + name)</script>`,
};
const browser = await launch({
  args: [...SWIFTSHADER, '--autoplay-policy=no-user-gesture-required'],
});
const MEDIA = {
  '/tone.wav': [TONE, 'audio/wav'],
  '/clip.webm': [await recordClip(browser, 4), 'video/webm'],
  '/sound-clip.webm': [await recordClip(browser, 4, { audio: true }), 'video/webm'],
};
// A page whose server takes 1.5 s to answer: the hidden views wait until it commits
const SLOW_PAGE = `<!doctype html><title>slow</title><p>slow<script>console.log('RESULT loaded=slow:' + Date.now())</script>`;
const { url: siteURL } = await serve((req, res) => {
  if (MEDIA[req.url]) return serveBytes(req, res, ...MEDIA[req.url]);
  if (req.url.startsWith('/slow')) {
    setTimeout(() => {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(SLOW_PAGE);
    }, 1500);
    return;
  }
  const page = PAGES[new URL(req.url, siteURL).pathname.slice(1)];
  if (!page) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(page);
});

const stack = await startStack({ token: 'background-token-0123456789ab' });

// Host page in a new context; results: [viewId, key, value] in order
async function openApp(params) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const results = [];
  watchErrors(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (VERBOSE) console.log('   ', text);
    const match = /\[page (\d+)\] RESULT (\w+)=(\S*)/.exec(text);
    if (match) results.push([Number(match[1]), match[2], match[3]]);
  });
  const wait = async (key, value = null, ms = 30000) => {
    for (
      const end = Date.now() + ms;
      Date.now() < end;
      await new Promise((r) => setTimeout(r, 100))
    ) {
      const found = results.find((r) => r[1] === key && (value === null || r[2] === value));
      if (found) {
        results.splice(results.indexOf(found), 1);
        return found;
      }
    }
    return null;
  };
  await page.goto(stack.app(params));
  if (!(await page.evaluate(() => window.blHost.ready)))
    throw new Error(
      `no browser: ${JSON.stringify(await page.evaluate(() => window.blHost.error))}`,
    );
  const go = (address) => load(page, address);
  // New view in front with an address; the previous one goes to the background
  const newTab = (address) => openView(page, address);
  const selectTab = (index) => selectView(page, index - 1);
  return { context, page, results, wait, go, newTab, selectTab };
}

// Frame requests of the engine per view (Module.onEngineNeedsFrame, engine/src/Host.cpp)
const countFrames = (page) =>
  page.evaluate(() => {
    const engine = window.blTest.browser.debug.module;
    if (!engine.blFrameCount) {
      const original = engine.onEngineNeedsFrame;
      engine.blFrameCount = {};
      engine.onEngineNeedsFrame = (id) => {
        engine.blFrameCount[id] = (engine.blFrameCount[id] || 0) + 1;
        original(id);
      };
    }
    return { ...engine.blFrameCount };
  });

// Place of the red box in a row of the visible page
const boxRow = (page) =>
  page.evaluate(() =>
    window.blTest.pageRow(50).findIndex(([r, g, b]) => r > 200 && g < 80 && b < 80),
  );

async function visibility(label, params) {
  const app = await openApp({ url: `${siteURL}moving`, ...params });
  const loaded = await app.wait('loaded');
  check(`${label}: page in front visible`, loaded?.[2] === 'visible', JSON.stringify(loaded));
  const viewId = loaded?.[0];
  await countFrames(app.page);
  await app.page.waitForTimeout(1000);
  const visibleFrames = (await countFrames(app.page))[viewId] || 0;
  check(
    `${label}: visible, the engine paints`,
    visibleFrames > 5,
    `${visibleFrames} frames in 1 s`,
  );

  await app.newTab(`${siteURL}empty`);
  const hidden = await app.wait('hidden');
  check(
    `${label}: background view gets visibilitychange, hidden`,
    hidden?.[0] === viewId && hidden?.[2] === 'hidden',
    JSON.stringify(hidden),
  );
  await app.wait('loaded', 'empty');
  await app.page.waitForTimeout(300);
  const before = (await countFrames(app.page))[viewId] || 0;
  await app.page.waitForTimeout(2500);
  const hiddenFrames = ((await countFrames(app.page))[viewId] || 0) - before;
  check(
    `${label}: hidden, the engine does not paint`,
    hiddenFrames === 0,
    `${hiddenFrames} frames in 2.5 s`,
  );
  // Show the canvas of the hidden view only in the host page: the compositor does not move the
  // box any more either (animation on the GPU)
  const hiddenRows = await app.page.evaluate(async () => {
    const canvas = document.querySelectorAll('canvas[data-bl-view]')[0];
    canvas.style.display = 'block';
    const rows = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const probe = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(
        0,
        Math.round((50 * canvas.height) / canvas.getBoundingClientRect().height),
        canvas.width,
        1,
      ).data;
      let x = -1;
      for (let p = 0; p < data.length && x < 0; p += 4) {
        if (data[p] > 200 && data[p + 1] < 80 && data[p + 2] < 80) x = p / 4;
      }
      rows.push(x);
    }
    canvas.style.display = 'none';
    return rows;
  });
  check(
    `${label}: hidden, the compositor frame stands still too`,
    new Set(hiddenRows).size === 1 && hiddenRows[0] >= 0,
    JSON.stringify(hiddenRows),
  );

  // Host page hidden: the active view is hidden too
  await app.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await app.selectTab(1);
  await app.page.waitForTimeout(800);
  const stillHidden = !app.results.some((r) => r[0] === viewId && r[1] === 'shown');
  await app.page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const shown = await app.wait('shown');
  const state = shown ? JSON.parse(shown[2]) : {};
  check(
    `${label}: host page hidden: the view stays hidden, then visible`,
    stillHidden && shown?.[0] === viewId && state.state === 'visible',
    JSON.stringify(state),
  );
  check(`${label}: hidden, no rAF`, state.raf <= 1, `${state.raf} rAF in ${state.seconds} s`);
  check(
    `${label}: hidden, setInterval at most about 1/s`,
    state.seconds >= 2.5 && state.ticksPerSecond <= 3,
    `${state.ticksPerSecond}/s`,
  );
  // Visible again: the engine (or the compositor) paints the animation on
  await app.page.waitForTimeout(500);
  const positions = new Set();
  for (let i = 0; i < 6; i++) {
    positions.add(await boxRow(app.page));
    await app.page.waitForTimeout(150);
  }
  check(
    `${label}: visible again: the animation runs`,
    positions.size >= 3 && !positions.has(-1),
    JSON.stringify([...positions]),
  );

  // With sound: sound and timers go on in the background
  await app.go(`${siteURL}sound`);
  const soundLoaded = await app.wait('loaded');
  await app.page.evaluate(() =>
    window.blTest.eval(
      'document.querySelector("audio").play().then(() => console.log("RESULT play=ok"), (e) => console.log("RESULT play=" + e.name))',
    ),
  );
  const play = await app.wait('play');
  const audible = await app.page
    .waitForFunction(() => window.blTest.view().audible, null, { timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check(`${label}: sound plays (audible)`, play?.[2] === 'ok' && audible, JSON.stringify(play));
  await app.selectTab(2);
  check(
    `${label}: view with sound hidden in the background`,
    (await app.wait('hidden'))?.[0] === soundLoaded?.[0],
  );
  const playerTime = () =>
    app.page.evaluate(() => window.blTest.mediaState().map((p) => [p.time, p.paused]));
  // Firefox reports the play before the host element starts (up to about 1.5 s later)
  await waitFor(async () => (await playerTime())[0]?.[0] > 0, 10000);
  const timeBefore = await playerTime();
  await app.page.waitForTimeout(3000);
  const timeAfter = await playerTime();
  check(
    `${label}: sound goes on in the background`,
    timeAfter.length === 1 && !timeAfter[0][1] && timeAfter[0][0] - timeBefore[0][0] > 2,
    `${JSON.stringify(timeBefore)} -> ${JSON.stringify(timeAfter)}`,
  );
  await app.selectTab(1);
  const soundShown = await app.wait('shown');
  const soundState = soundShown ? JSON.parse(soundShown[2]) : {};
  check(
    `${label}: with sound, timers not throttled`,
    soundState.ticksPerSecond > 20,
    `${soundState.ticksPerSecond}/s`,
  );
  await app.context.close();
}

await visibility('compositor', {});
await visibility('without compositor', { compositing: '0' });

// Typing in the front view while a hidden view runs long tasks: the hidden view waits until the
// user pauses (engine/src/HiddenViews.cpp), the keys do not wait for its tasks
const typing = await openApp({ url: `${siteURL}busy` });
await typing.wait('loaded', 'busy');
await typing.newTab(`${siteURL}typing`);
await typing.wait('loaded', 'typing');
const typingOrigin = await canvasOrigin(typing.page);
await typing.page.mouse.click(typingOrigin.x + 100, typingOrigin.y + 25);
// The click is input too: after the pause the hidden view is busy again
await typing.page.waitForTimeout(2500);
const chunkTimes = () => typing.results.filter((r) => r[1] === 'chunk').map((r) => Number(r[2]));
const chunksBetween = (from, to) => chunkTimes().filter((time) => time > from && time <= to).length;
check(
  'typing: the hidden view is busy before',
  chunkTimes().some((time) => time > Date.now() - 1500),
);
// Two bursts of keys with a pause like someone who thinks, the focus stays in the field
const typeBurst = async (keys) => {
  const sent = [];
  for (const key of keys) {
    sent.push(Date.now());
    await typing.page.keyboard.press(key);
    await typing.page.waitForTimeout(150);
  }
  return sent;
};
const sent = await typeBurst('abcdefghijkl');
const typed = Date.now();
await typing.page.waitForTimeout(2500);
const paused = Date.now();
const sentAgain = await typeBurst('mnop');
await typing.page.waitForTimeout(1000);
const keydowns = typing.results.filter((r) => r[1] === 'keydown').map((r) => r[2].split(':'));
check(
  'typing: every key arrives in order',
  keydowns.map(([key]) => key).join('') === 'abcdefghijklmnop',
  keydowns.map(([key]) => key).join(''),
);
// The first key may wait for the task that runs when it comes
const latencies = [...sent.slice(1), ...sentAgain]
  .map((time, i) => Number(keydowns[i + 1]?.[1]) - time)
  .sort((a, b) => a - b);
const medianLatency = latencies[Math.floor(latencies.length / 2)];
check(
  'typing: keys do not wait for the hidden view',
  medianLatency < 120,
  `median ${medianLatency} ms: ${latencies.join(' ')}`,
);
const whileTyping = chunksBetween(sent[1], typed);
check(
  'typing: the hidden view waits while the user types',
  whileTyping <= 1,
  `${whileTyping} tasks`,
);
const inPause = chunksBetween(typed, Date.now());
const afterPause = Number(keydowns[sent.length]?.[1]) - sentAgain[0];
check(
  'typing: with the focus in the field the hidden view waits through a pause of 2.5 s',
  inPause === 0 && afterPause < 120,
  `${inPause} tasks, first key after the pause ${afterPause} ms (pause ended ${paused - typed} ms after typing)`,
);
// The focus leaves the field: the hidden view goes on after the quiet time of the click
await typing.page.mouse.click(typingOrigin.x + 100, typingOrigin.y + 300);
const clickedAway = Date.now();
await typing.page.waitForTimeout(3000);
const afterTyping = chunksBetween(clickedAway, Date.now());
check(
  'typing: the hidden view goes on when the focus left the field',
  afterTyping >= 2,
  `${afterTyping} tasks`,
);

// The front view loads a page (1.5 s until the response): the hidden view waits until it
// commits. The load is no input: it may still come after the running task and the one that task
// queued (500 ms each)
const loadInFront = async (label, start) => {
  const started = Date.now();
  await start();
  const loaded = await typing.wait('loaded', null, 15000);
  const committed = Number(loaded?.[2].split(':')[1]);
  const during = chunksBetween(started + 1100, committed);
  check(
    `${label}: the hidden view waits while the visible view loads`,
    loaded?.[2].startsWith('slow:') && during === 0,
    `${during} tasks in ${committed - started} ms`,
  );
  await typing.page.waitForTimeout(3000);
  const after = chunksBetween(committed, Date.now());
  check(`${label}: the hidden view goes on after the commit`, after >= 2, `${after} tasks`);
};
await loadInFront('navigation', () => typing.go(`${siteURL}slow?front`));
await loadInFront('new tab', () => typing.newTab(`${siteURL}slow?tab`));
await typing.context.close();

// The hidden view's restyles and relayouts run from timers of their own and image load events
// from a timer shared by all pages: the click that starts the hold may still wait for the running
// task, but no restyle, relayout or load event of the hidden view comes after it and keeps the
// keys waiting (patches 0125, 0126). The click mostly comes in a task after which they are due,
// at least one of four bursts did before. The mouse was over the hidden view before: the hit test
// 200 ms after each of its layouts that finds the element under the mouse waits too (patch 0131).
const restyling = await openApp({ url: `${siteURL}restyle` });
const restyleCost = Number((await restyling.wait('restyle'))?.[2]);
await restyling.wait('loaded', 'restyle');
const restyleOrigin = await canvasOrigin(restyling.page);
await restyling.page.mouse.move(restyleOrigin.x + 200, restyleOrigin.y + 200);
await restyling.page.mouse.move(restyleOrigin.x + 210, restyleOrigin.y + 210);
await restyling.page.waitForTimeout(300);
await restyling.newTab(`${siteURL}typing`);
await restyling.wait('loaded', 'typing');
const restylingOrigin = await canvasOrigin(restyling.page);
const restyleBursts = [];
for (let burst = 0; burst < 4; burst++) {
  await restyling.page.mouse.click(restylingOrigin.x + 100, restylingOrigin.y + 300);
  // Away from the field the hold ends 1 s after the click: the hidden view restyles again
  await restyling.page.waitForTimeout(2500);
  restyling.results.splice(0, restyling.results.length);
  // The click into the field starts the hold once the running task ended: type right after it
  await restyling.page.mouse.click(restylingOrigin.x + 100, restylingOrigin.y + 25);
  await restyling.wait('mousedown', null, 10000);
  const sentKeys = [];
  for (const key of 'abcdef') {
    sentKeys.push(Date.now());
    await restyling.page.keyboard.press(key);
    await restyling.page.waitForTimeout(150);
  }
  await restyling.page.waitForTimeout(500);
  const arrived = restyling.results
    .filter((r) => r[1] === 'keydown')
    .map((r) => Number(r[2].split(':')[1]));
  restyleBursts.push(...sentKeys.map((time, i) => arrived[i] - time));
}
// Away from the field the hidden view goes on, its held load events too
await restyling.page.mouse.click(restylingOrigin.x + 100, restylingOrigin.y + 300);
const leftField = Date.now();
await restyling.page.waitForTimeout(6000);
const imageLoads = restyling.results.filter(
  (r) => r[1] === 'imageload' && Number(r[2]) > leftField,
);
check(
  'typing: the hidden view goes on afterwards, also its load events',
  imageLoads.length >= 2,
  `${imageLoads.length} load events`,
);
const restyleWorst = Math.max(...restyleBursts);
check(
  'typing: no restyle, relayout or load event of the hidden view between the keys',
  restyleCost >= 50 && restyleWorst < Math.max(100, restyleCost / 4),
  `restyle and relayout ${restyleCost} ms, keys ${restyleBursts.join(' ')} ms`,
);
await restyling.context.close();

// Switching to a view that changed in the background: hidden views wait from the end of the
// running task on (urgent, like input) until the shown view made its first frame, which comes
// before the shown view's own waiting tasks. With layers the compositor may first have to show the
// frame from before the view was hidden: one task of the view can run meanwhile.
async function tabSwitch(label, params) {
  const app = await openApp({ url: `${siteURL}batches`, ...params });
  await app.wait('loaded', 'batches');
  await app.newTab(`${siteURL}shown`);
  await app.wait('loaded', 'shown');
  await app.newTab(`${siteURL}empty`);
  await app.wait('loaded', 'empty');
  await app.page.waitForTimeout(3000);
  const tasks = (key) =>
    app.results.filter((r) => r[1] === key).map((r) => r[2].split(':').map(Number));
  const switched = await app.page.evaluate(() => {
    const time = Date.now();
    window.blHost.select(1);
    return time;
  });
  const frame = Number((await app.wait('frame', null, 15000))?.[2]);
  const before = (key) =>
    tasks(key).filter(([start, end]) => start > switched && end <= frame).length;
  const hidden = before('task');
  check(
    `${label}: tab switch: the hidden view starts no task before the first frame of the shown view`,
    frame > 0 && hidden === 0,
    `${hidden} tasks, frame ${frame - switched} ms after the switch`,
  );
  const own = before('own');
  check(
    `${label}: tab switch: the frame of the shown view comes before its own waiting tasks`,
    frame > 0 && own <= (params.compositing === '0' ? 0 : 1),
    `${own} tasks`,
  );
  await app.page.waitForTimeout(3000);
  const after = tasks('task').filter(([start]) => start > frame).length;
  check(
    `${label}: tab switch: the hidden view goes on after the frame`,
    after >= 4,
    `${after} tasks`,
  );
  await app.context.close();
}
await tabSwitch('compositor', {});
await tabSwitch('without compositor', { compositing: '0' });

// Memory pressure: over the limit the engine reports at every growth by 32 MB. The limit is just
// above the memory of the same session without pressure.
async function memorySession(params) {
  const app = await openApp({ url: `${siteURL}memory?one`, ...params });
  await app.wait('loaded', 'one');
  await app.newTab(`${siteURL}memory?two`);
  await app.wait('loaded', 'two');
  await app.newTab(`${siteURL}memory?three`);
  await app.wait('loaded', 'three');
  await app.page.waitForTimeout(1000);
  return app;
}
const pressureEvents = (page) =>
  page.evaluate(() => window.blHost.events.filter((e) => e === 'memory-pressure').length);
const probe = await memorySession({});
const baseMB = Math.ceil((await probe.page.evaluate(() => window.blTest.memory())) / 2 ** 20);
await probe.context.close();
const app = await memorySession({ env: `BL_MEMORY_PRESSURE_MB=${baseMB + 96}` });
check(
  'memory pressure: no event before',
  (await pressureEvents(app.page)) === 0,
  `limit ${baseMB + 96} MB`,
);
const allocate = (mb) =>
  app.page.evaluate(
    (size) =>
      window.blTest.eval(
        `(window.big ||= []).push(new Uint8Array(${size} << 20).fill(1)); console.log("RESULT allocated=" + big.length)`,
      ),
    mb,
  );
for (let i = 0; i < 12 && (await pressureEvents(app.page)) < 2; i++) {
  await allocate(64);
  await app.wait('allocated');
  await app.page.waitForTimeout(500);
}
const pressure = await pressureEvents(app.page);
check(
  'memory pressure: events while the memory grows over the limit',
  pressure >= 2,
  `${pressure} events`,
);
check(
  'memory pressure: the core closes no view itself',
  (await app.page.evaluate(() => window.blTest.views().length)) === 3 &&
    !app.results.some((r) => r[1] === 'gone'),
);
await app.context.close();

// A script nobody waits for runs to its end, also beyond the limit (an anti-bot challenge on a
// slow device); one that keeps an input waiting is stopped once the input waited the limit
const busy = await openApp({ url: `${siteURL}stuck`, scripttimeout: '3' });
await busy.wait('loaded', 'stuck');
const spin = (seconds, name) =>
  busy.page.evaluate(
    (source) => window.blTest.eval(source),
    `setTimeout(() => { const end = Date.now() + ${seconds * 1000}; while (Date.now() < end); console.log("RESULT ${name}=done"); }, 0)`,
  );
await spin(6, 'unwatched');
check(
  'a script nobody waits for runs past the limit',
  !!(await busy.wait('unwatched', 'done', 20000)),
);
await spin(15, 'watched');
await busy.page.waitForTimeout(1000);
const busyOrigin = await canvasOrigin(busy.page);
const pressed = Date.now();
await busy.page.mouse.click(busyOrigin.x + 100, busyOrigin.y + 100);
await busy.page.evaluate(() => window.blTest.eval('console.log("RESULT after=1")'));
const answered = await busy.wait('after', '1', 20000);
const stoppedAfter = (Date.now() - pressed) / 1000;
check(
  'a script that keeps a click waiting is stopped once the click waited the limit',
  !!answered &&
    stoppedAfter > 2.5 &&
    stoppedAfter < 6 &&
    !busy.results.some((result) => result[1] === 'watched'),
  `${stoppedAfter.toFixed(1)} s`,
);
await busy.context.close();

// Hang after an input: the engine thread finishes no task any more
const hang = await openApp({ url: `${siteURL}stuck`, scripttimeout: '20' });
await hang.wait('loaded', 'stuck');
const origin = await canvasOrigin(hang.page);
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
await hang.page.waitForTimeout(11500);
check(
  'click without a hang: no unresponsive event',
  !(await hostEvents(hang.page)).includes('unresponsive'),
);
await hang.page.evaluate(() => window.blTest.eval('location.hash = "go"'));
await hang.page.waitForTimeout(500);
const clicked = Date.now();
await hang.page.mouse.click(origin.x + 100, origin.y + 100);
const shownHang = await waitEvent(hang.page, 'unresponsive', 14000);
check(
  'click into a hanging page: unresponsive after 10 s',
  !!shownHang && Date.now() - clicked >= 9500,
  `${Date.now() - clicked} ms`,
);
// The user waits: the browser reports the hang again 10 s later
await hang.page.evaluate(() => window.blHost.keepWaiting());
const waited = Date.now();
await hang.page
  .waitForFunction(
    () => window.blHost.events.filter((e) => e === 'unresponsive').length >= 2,
    null,
    { timeout: 14000 },
  )
  .catch(() => {});
const repeats = (await hostEvents(hang.page)).filter((e) => e === 'unresponsive').length;
check(
  'keepWaiting(): unresponsive again after another 10 s',
  repeats === 2 && Date.now() - waited >= 9500,
  `${repeats}x after ${Date.now() - waited} ms`,
);
// The engine gives the script the whole limit again: stopped 20 s after keepWaiting(), not 20 s
// after the click
const recovered = await waitEvent(hang.page, 'responsive', 15000);
check(
  'hang after a click: responsive once the script kept the host waiting 20 s after keepWaiting()',
  !!recovered && Date.now() - waited >= 18000,
  `${Date.now() - waited} ms`,
);
await hang.context.close();

// A native dialog of the host page stops its main thread: the time until the answer does not
// count as a hang, even when the input is still open
const dialog = await openApp({ url: `${siteURL}dialog` });
await dialog.page.evaluate(() => {
  window.blHost.dialogMode = 'native';
});
await dialog.wait('loaded', 'dialog');
let alerts = 0;
dialog.page.on('dialog', async (d) => {
  if (d.type() !== 'alert') return d.dismiss();
  alerts++;
  await new Promise((r) => setTimeout(r, 12000));
  await d.accept();
});
const dialogOrigin = await canvasOrigin(dialog.page);
await dialog.page.mouse.click(dialogOrigin.x + 100, dialogOrigin.y + 100);
await dialog.page.waitForTimeout(500);
dialog.page.keyboard.press('a').catch(() => {});
const alerted = await dialog.wait('alerted', null, 30000);
await dialog.page.waitForTimeout(2500);
const hangSeen = (await hostEvents(dialog.page)).filter((e) => e === 'unresponsive').length;
check(
  'long alert after a key: no unresponsive event',
  alerts === 1 && !!alerted && hangSeen === 0,
  `${alerts} dialogs, unresponsive ${hangSeen}x`,
);
await dialog.context.close();

// Hidden like Chrome: only the video without an audio track pauses, in the host too (it stops
// decoding); the host tells which one has an audio track. Visible again, it plays on.
const silent = await openApp({ url: `${siteURL}videos` });
await silent.wait('loaded', 'videos');
const bothPlaying =
  !!(await silent.wait('playing', 'silent')) && !!(await silent.wait('playing', 'sound'));
check('videos: both muted videos play', bothPlaying);
// Only what comes from here on (at the start muted playback briefly reports pause)
await silent.page.waitForTimeout(1000);
silent.results.length = 0;
await silent.newTab(`${siteURL}empty`);
const silentHidden = await silent.wait('state');
const hostVideos = () =>
  silent.page.evaluate(() =>
    window.blTest
      .mediaState()
      .map((p) => [p.time, p.paused])
      .sort((a, b) => Number(b[1]) - Number(a[1])),
  );
await silent.page.waitForTimeout(500);
const hostBefore = await hostVideos();
await silent.page.waitForTimeout(2000);
const hostAfter = await hostVideos();
const silentPaused = silent.results.filter((r) => r[1] === 'pause').map((r) => r[2]);
check(
  'videos: hidden, only the video without an audio track pauses',
  silentHidden?.[2] === 'hidden:true:false' && silentPaused.join() === 'silent',
  `${JSON.stringify(silentHidden)} paused: ${silentPaused}`,
);
check(
  'videos: hidden, the host stops that video and plays the other',
  hostAfter.length === 2 &&
    hostAfter[0][1] &&
    hostAfter[0][0] === hostBefore[0][0] &&
    !hostAfter[1][1] &&
    hostAfter[1][0] !== hostBefore[1][0],
  `${JSON.stringify(hostBefore)} -> ${JSON.stringify(hostAfter)}`,
);
await silent.selectTab(1);
check('videos: visible again, the video plays on', !!(await silent.wait('playing', 'silent')));
await silent.context.close();

// Muted in the background like Chrome: a srcObject stream and muted sound go on (only video
// without an audio track is paused)
const muted = await openApp({ url: `${siteURL}stream` });
check('muted: stream and sound play', (await muted.wait('playing'))?.[2] === 'stream');
// Only what comes from here on (at the start muted playback briefly reports pause, see docs)
await muted.page.waitForTimeout(1000);
muted.results.length = 0;
await muted.newTab(`${siteURL}empty`);
const mutedHidden = await muted.wait('state');
await muted.page.waitForTimeout(2000);
const mutedPaused = muted.results.filter((r) => r[1] === 'pause').map((r) => r[2]);
check(
  'muted: stream and sound go on in the background',
  mutedHidden?.[2] === 'hidden:false:false' && !mutedPaused.length,
  `${JSON.stringify(mutedHidden)} paused: ${mutedPaused}`,
);
await muted.context.close();

// A muted video in the PiP window: WebKit pauses muted playback of hidden pages, but the video in
// the PiP window is visible (like in Chrome)
const pip = await openApp({ url: `${siteURL}pip` });
await pip.wait('loaded', 'pip');
check('PiP: muted video plays', !!(await pip.wait('playing', 'visible')));
// Firefox has no picture-in-picture API (the pages do not see it either, media-test.mjs)
if (await pip.page.evaluate(() => 'requestPictureInPicture' in HTMLVideoElement.prototype)) {
  const pipOrigin = await canvasOrigin(pip.page);
  await pip.page.mouse.click(pipOrigin.x + 100, pipOrigin.y + 100);
  const entered = await pip.wait('pip');
  const hostPip = await pip.page.evaluate(() => !!document.pictureInPictureElement);
  check(
    'PiP: video in the PiP window (picture-in-picture event)',
    entered?.[2] === 'ok' &&
      hostPip &&
      !!(await waitEvent(pip.page, 'picture-in-picture:true', 5000)),
    JSON.stringify(entered),
  );
  // Only what comes from here on (autoplay also reports pause at the start)
  pip.results.length = 0;
  await pip.newTab(`${siteURL}empty`);
  check('PiP: view hidden in the background', !!(await pip.wait('state', 'hidden')));
  const pipBefore = await pip.page.evaluate(() => window.blTest.mediaState().map((p) => p.time));
  await pip.page.waitForTimeout(3000);
  const pipAfter = await pip.page.evaluate(() =>
    window.blTest.mediaState().map((p) => [p.time, p.paused]),
  );
  const paused = pip.results.find((r) => r[1] === 'pause');
  check(
    'PiP: video goes on in the background',
    !paused && pipAfter.length === 1 && !pipAfter[0][1] && pipAfter[0][0] !== pipBefore[0],
    `${JSON.stringify(paused)} ${JSON.stringify(pipBefore)} -> ${JSON.stringify(pipAfter)}`,
  );
  await pip.page.evaluate(() => document.exitPictureInPicture().catch(() => {}));
} else console.log('skip PiP in the background (the host has no picture-in-picture)');
await pip.context.close();

await browser.close();
finish();
