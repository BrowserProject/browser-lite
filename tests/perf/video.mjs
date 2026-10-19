// Cost of video playback: CPU seconds per second of the device and shown frames per second over a
// quiet window, for browser-lite playing a muted looping 720p VP9 video, browser-lite with the same
// page and the video not playing, and Chromium playing the page itself. Needs the live server
// (the replay server does not answer range requests reliably).
//   node video.mjs --out <jsonl> --runs n [--label x]
import fs from 'node:fs';
import { createServer, connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out');
const runs = Number(arg('runs', 3));
const label = arg('label', '');
const WARMUP = 8000;
const WINDOW = 20000;
// Chromium of Playwright has no H.264, so VP9 (PERF_VIDEO_URL; setup.sh keeps a copy for the device's
// own Chromium, which has no internet in the device network)
const VIDEO = /^PERF_VIDEO_URL=(.*)$/m.exec(fs.readFileSync('/w/versions.env', 'utf8'))[1];
const page = (play) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>video</title><body style="margin:0"><video src="${VIDEO}" ${play ? 'autoplay' : 'preload="auto"'} muted loop playsinline style="width:1280px;height:720px"></video>`)}`;

const upstream = new URL(process.env.SERVER);
const forwarder = createServer((client) => {
  const server = connect(Number(upstream.port), upstream.hostname);
  client.pipe(server).pipe(client);
  client.on('error', () => server.destroy());
  server.on('error', () => client.destroy());
});
await new Promise((resolve) => forwarder.listen(8080, '127.0.0.1', resolve));
const cpuSeconds = () =>
  Number(/usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))[1]) / 1e6;

async function measure(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-perf-video-'));
  const context = await chromium.launchPersistentContext(dir, {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    viewport: { width: 1280, height: 800 },
  });
  const tab = context.pages()[0] || (await context.newPage());
  const native = mode === 'chromium-play';
  const frames = native
    ? () =>
        tab.evaluate(
          () => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames,
        )
    : () => tab.evaluate(() => window.blTest.mediaState()[0]?.frames ?? 0);
  if (native) {
    await tab.route(VIDEO, (route) =>
      route.fulfill({ path: '/w/build/perf/video.webm', contentType: 'video/webm' }),
    );
    await tab.goto(page(true));
  } else
    await tab.goto(
      `http://localhost:8080/?debug=1&url=${encodeURIComponent(page(mode === 'bl-play'))}`,
    );
  await tab.waitForTimeout(WARMUP);
  const t0 = Date.now();
  const cpu0 = cpuSeconds();
  const frames0 = await frames().catch(() => 0);
  await tab.waitForTimeout(WINDOW);
  const seconds = (Date.now() - t0) / 1000;
  const cpu = (cpuSeconds() - cpu0) / seconds;
  const fps = ((await frames().catch(() => 0)) - frames0) / seconds;
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    status: 'ok',
    t0,
    wall: Math.round(seconds * 1000),
    cpuPerSecond: +cpu.toFixed(3),
    fps: +fps.toFixed(1),
  };
}

const modes = ['bl-play', 'bl-idle', 'chromium-play'];
for (let run = 0; run < runs; run++)
  for (const mode of run % 2 === 0 ? modes : [...modes].reverse()) {
    const r = await measure(mode);
    const row = {
      kind: 'video',
      label,
      profile: process.env.PERF_PROFILE,
      net: process.env.PERF_NET,
      config: mode,
      site: 'video',
      run,
      ...r,
    };
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(`${row.profile} ${mode} #${run}: ${r.cpuPerSecond} CPU s/s, ${r.fps} fps`);
  }
forwarder.close();
process.exit(0);
