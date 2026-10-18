// Background views through @browser-lite/core (WebView::setVisible, View.setVisible): hidden pages
// see visibilityState 'hidden', rAF and CSS animations stop, setInterval runs at most about once
// per second, the engine does not paint; with sound, sound and timers go on. With and without the
// compositor. Also memory pressure (the engine reports "memory-pressure"), the watchdog after an
// input (unresponsive, responsive) and no hang during a long native dialog of the host page, a
// muted video in the picture-in-picture window keeps running hidden, so do a srcObject stream and
// muted sound.
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
  recordClip,
  serve,
  serveBytes,
  startStack,
  timeLimit,
  waitEvent,
  watchErrors,
  wav,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 300000);

const TONE = wav(60, { amplitude: 4000 });

// Counts rAF and a timer (10 ms); hiding and showing report what ran in between. The CSS
// animation runs with layers in the compositor.
const VISIBILITY_SCRIPT = `
let raf = 0, ticks = 0, mark = null;
const loop = () => { raf++; requestAnimationFrame(loop); };
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
};
const { url: siteURL } = await serve((req, res) => {
  if (MEDIA[req.url]) return serveBytes(req, res, ...MEDIA[req.url]);
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
  const go = (address) => page.evaluate((url) => window.blTest.load(url), address);
  // New view in front with an address; the previous one goes to the background
  const newTab = (address) => page.evaluate((url) => window.blTest.open(url), address);
  const selectTab = (index) => page.evaluate((i) => window.blHost.select(i - 1), index);
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
        Math.round((50 * canvas.height) / canvas.clientHeight),
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
const recovered = await waitEvent(hang.page, 'responsive', 15000);
check('hang after a click: responsive as soon as the watchdog stops the script', !!recovered);
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
await pip.context.close();

await browser.close();
finish();
