// Cost of moving pictures: CPU seconds per second of the device, frames shown per second, CPU
// seconds per shown frame and memory over a quiet window from 8 s after the first shown frame on,
// for the engines of the arms (configs as in run.mjs, measure.mjs readConfigs) and Chromium showing
// the same page itself (arm "chromium").
// Arms take turns per run (ABBA). Pages (--page):
//   video     muted looping 720p VP9 video (PERF_VIDEO_URL)
//   video360  the same at 360p (PERF_VIDEO360_URL), a load below saturation
//   webgl     a WebGL animation (a shader over the whole canvas, drawn every animation frame)
//   anim      CSS animations (a moving box and one that is painted again in every frame)
//   scroll    a long page with a fixed bar that scrolls up and down in every animation frame
//             (every frame changes the whole view)
//   idle      a CSS animation outside the view: the compositor runs, nothing visible changes
// Shown frames: browser-lite counts in its compositor (debug.measurements(), frames with a new
// video or WebGL image; all frames with a change for anim, scroll and idle), Chromium
// totalVideoFrames minus droppedVideoFrames of the video and the frames the WebGL page drew; anim,
// scroll and idle have no frame count in Chromium. Video pages need the live server (the replay
// server does not answer range requests reliably).
//   node frames.mjs --out <jsonl> --page <page> --runs n [--label x] [--configs '<json>']
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  arg,
  armOrder,
  cpuSeconds,
  forwardSites,
  memory,
  readConfigs,
  startError,
  testOptions,
} from './measure.mjs';

const out = arg('out');
const pageName = arg('page', 'video');
const runs = Number(arg('runs', 3));
const label = arg('label', '');
const WARMUP = 8000;
const WINDOW = 20000;
const START_TIMEOUT = 120000;

// Chromium of Playwright has no H.264, so VP9; setup.sh keeps a copy of each video for the device's
// own Chromium, which has no internet in the device network
const pins = fs.readFileSync('/w/versions.env', 'utf8');
const pin = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(pins)[1];
// Each video is shown at its own size
const VIDEOS = {
  video: { url: pin('PERF_VIDEO_URL'), file: '/w/build/perf/video.webm', width: 1280, height: 720 },
  video360: {
    url: pin('PERF_VIDEO360_URL'),
    file: '/w/build/perf/video360.webm',
    width: 640,
    height: 360,
  },
};

const WEBGL = `<canvas width="1280" height="720"></canvas><script>
const gl = document.querySelector('canvas').getContext('webgl');
const shader = (type, source) => {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  return s;
};
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; uniform float t; void main() { vec2 uv = gl_FragCoord.xy / vec2(1280.0, 720.0); gl_FragColor = vec4(0.5 + 0.5 * sin(t + uv.x * 6.0), 0.5 + 0.5 * sin(t * 1.3 + uv.y * 6.0), 0.5 + 0.5 * sin(t * 0.7), 1.0); }'));
gl.linkProgram(program);
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const time = gl.getUniformLocation(program, 't');
window.drawnFrames = 0;
const draw = (now) => {
  gl.uniform1f(time, now / 1000);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  window.drawnFrames++;
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
</script>`;
const ANIM = `<style>
.move { position: absolute; left: 40px; top: 60px; width: 200px; height: 200px; background: #36c; animation: move 2s linear infinite alternate; }
.paint { position: absolute; left: 40px; top: 400px; width: 600px; height: 120px; animation: paint 1s linear infinite alternate; }
@keyframes move { to { transform: translateX(900px) rotate(180deg); } }
@keyframes paint { from { background: #c33; } to { background: #3c3; } }
</style><div class="move"></div><div class="paint"></div>`;
const SCROLL = `<style>
body { font: 16px sans-serif; }
header { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #234; color: #fff; }
.row { height: 120px; margin: 12px; padding: 8px; background: linear-gradient(90deg, #fc9, #9cf); }
</style><header>scroll</header><script>
for (let i = 0; i < 200; i++) {
  const row = document.body.appendChild(document.createElement('div'));
  row.className = 'row';
  row.textContent = 'Row ' + i + ': the quick brown fox jumps over the lazy dog';
}
let y = 0;
let step = 8;
const scroll = () => {
  const end = document.documentElement.scrollHeight - innerHeight;
  y += step;
  if (y <= 0 || y >= end) step = -step;
  scrollTo(0, y);
  requestAnimationFrame(scroll);
};
requestAnimationFrame(scroll);
</script>`;
const IDLE = `<style>
.spin { position: absolute; left: -400px; top: 100px; width: 200px; height: 200px; background: #36c; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style><div class="spin"></div><p>Nothing here moves.</p>`;
const video = VIDEOS[pageName];
const body = video
  ? `<video src="${video.url}" autoplay muted loop playsinline style="width:${video.width}px;height:${video.height}px"></video>`
  : { webgl: WEBGL, anim: ANIM, scroll: SCROLL, idle: IDLE }[pageName];
if (!body) throw new Error(`unknown page ${pageName}`);
const pageURL = `data:text/html,${encodeURIComponent(`<!doctype html><title>${pageName}</title><body style="margin:0">${body}`)}`;

/** Frames shown so far by Chromium itself (in the page), null where it has no count. */
const chromiumFrames = video
  ? () => {
      const quality = document.querySelector('video').getVideoPlaybackQuality();
      return quality.totalVideoFrames - quality.droppedVideoFrames;
    }
  : pageName === 'webgl'
    ? () => window.drawnFrames
    : () => null;

/** Waits until the page has shown a frame; false after START_TIMEOUT. */
async function firstFrame(tab, readFrames) {
  for (const end = Date.now() + START_TIMEOUT; Date.now() < end; await tab.waitForTimeout(250))
    if ((await readFrames().catch(() => null)) > 0) return true;
  return false;
}

const origins = await forwardSites();
const configs = [...readConfigs(origins), { name: 'chromium', native: true }];

async function measure(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-frames-'));
  const context = await chromium.launchPersistentContext(dir, {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    viewport: { width: 1280, height: 800 },
  });
  const { native } = config;
  if (!native) await testOptions(context, null, config.engine);
  const tab = context.pages()[0] || (await context.newPage());
  const failed = native ? null : startError(tab);
  let readFrames;
  if (native) {
    if (video)
      await tab.route(video.url, (route) =>
        route.fulfill({ path: video.file, contentType: 'video/webm' }),
      );
    await tab.goto(pageURL);
    readFrames = () => tab.evaluate(chromiumFrames);
  } else {
    const query = new URLSearchParams({ url: pageURL, debug: '1', ...config.params });
    await tab.goto(`${origins[config.site]}/?${query}`);
    const all = ['anim', 'scroll', 'idle'].includes(pageName);
    readFrames = () =>
      tab.evaluate((all) => {
        const shown = window.blTest.measurements();
        return shown ? (all ? shown.framesShown : shown.contentFramesShown) : null;
      }, all);
  }
  // Warm up from the first shown frame on: every run starts cold, the engine alone takes about
  // 12 s on C then
  const counted = !native || video || pageName === 'webgl';
  const shown = counted ? firstFrame(tab, readFrames) : Promise.resolve(true);
  if (!(await (failed ? Promise.race([shown, failed]) : shown))) {
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: 'timeout', t0: Date.now(), wall: 0 };
  }
  await tab.waitForTimeout(WARMUP);
  const t0 = Date.now();
  const cpu0 = cpuSeconds();
  const frames0 = await readFrames().catch(() => null);
  await tab.waitForTimeout(WINDOW);
  const frames1 = await readFrames().catch(() => null);
  const seconds = (Date.now() - t0) / 1000;
  const cpu = cpuSeconds() - cpu0;
  const mem = memory();
  const wasm = native
    ? null
    : await tab.evaluate(() => window.blTest.measurements()?.memoryBytes).catch(() => null);
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // idle: only CPU per second counts, with damage tracking next to no frame is shown
  const frames =
    frames0 != null && frames1 != null && pageName !== 'idle' ? frames1 - frames0 : null;
  return {
    status: counted && pageName !== 'idle' && !frames ? 'no-frames' : 'ok',
    t0,
    wall: Math.round(seconds * 1000),
    cpuPerSecond: +(cpu / seconds).toFixed(3),
    fps: frames != null ? +(frames / seconds).toFixed(1) : null,
    cpuPerFrame: frames ? +(cpu / frames).toFixed(4) : null,
    ...mem,
    wasmMB: wasm ? Math.round(wasm / 1048576) : null,
  };
}

for (let run = 0; run < runs; run++)
  for (const config of armOrder(configs, run)) {
    const r = await measure(config);
    const row = {
      kind: 'frames',
      label,
      profile: process.env.PERF_PROFILE,
      net: process.env.PERF_NET,
      site: pageName,
      config: config.name,
      engineSite: config.native ? null : config.site,
      run,
      ...r,
    };
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(
      `${row.profile} ${pageName} ${config.name} #${run}: ${r.status} ${r.cpuPerSecond} CPU s/s, ${r.fps} fps, ${r.cpuPerFrame} CPU s/frame, ${r.anonMB} MB anon`,
    );
  }
process.exit(0);
