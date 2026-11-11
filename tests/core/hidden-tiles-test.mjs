// Hidden views give back the memory of their tiles (engine/src/LayerTreeHostWasm.cpp,
// releaseTiles): a view hidden for 10 s drops the tiles of its layers and the compositor their
// textures, which in Chromium with SwiftShader (and on integrated GPUs) are memory of the GPU
// process. Hidden for a few seconds only, the view keeps them. Shown again, it keeps its last frame
// until its tiles are painted again (no frame shows the layers empty) and then looks exactly as
// before. Checks the engine's count (memory report) and, in Chromium on Linux, how the GPU process
// grows with tabs.
//
//   node tests/core/hidden-tiles-test.mjs [engine-dir]
import { execFileSync } from 'node:child_process';
import {
  BROWSER,
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
} from '../lib/index.mjs';

timeLimit();

// Six layers with text over the whole view, then long text: tiles of about 40 MB
const LAYERS = 6;
const COLORS = ['#c03030', '#30a030', '#3050c0', '#c0a020', '#a030a0', '#209090'];
const PAGE = `<!doctype html><title>Hidden tiles</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  .layer { position: absolute; left: 0; width: 1200px; height: 760px; will-change: transform; color: #fff; }
  p { margin: 0 0 8px 0; }
</style>
${Array.from({ length: LAYERS }, (_, i) => `<div class="layer" style="top:${i * 6}px;background:${COLORS[i]}">${`Layer ${i} with some text to paint. `.repeat(40)}</div>`).join('')}
<div style="position:absolute;top:800px">${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i}: ${'words to fill the line '.repeat(8)}</p>`).join('')}</div>
<script>console.log('RESULT ready=1');</script>`;
// The top layer at this point
const PROBE = { x: 600, y: 400 };
const TOP = [0x20, 0x90, 0x90];

const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const results = collect(page);

// The engine's memory report: textures of the layers in MB (with those the pool keeps for reuse)
let reportLine = null;
page.on('console', (message) => {
  const text = message.text();
  if (text.includes('[memory] GPU compositor:')) reportLine = text;
});
const textures = async () => {
  reportLine = null;
  await page.evaluate(() => window.blTest.memory(0));
  await waitFor(async () => reportLine !== null, 5000, 50);
  const match = reportLine?.match(/layer textures (\d+) MB/);
  return match ? Number(match[1]) : null;
};

// Resident memory in MB of the GPU process of the Chromium this test started (Linux), else null
const gpuProcessMB = () => {
  if (BROWSER !== 'chromium' || process.platform !== 'linux') return null;
  const pid = process.pid;
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/));
  const ours = new Set([String(pid)]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const row of rows)
      if (ours.has(row[1]) && !ours.has(row[0])) {
        ours.add(row[0]);
        grown = true;
      }
  }
  const gpu = rows.find((row) => ours.has(row[0]) && row.join(' ').includes('--type=gpu-process'));
  return gpu ? Math.round(Number(gpu[2]) / 1024) : null;
};

// The view as the host shows it at PROBE (view canvas and damage tiles), each frame for ms
const probeFrames = (ms) =>
  page.evaluate(
    async ({ x, y, ms }) => {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      const context = probe.getContext('2d', { willReadFrequently: true });
      const view = document.querySelector(`canvas[data-bl-view="${window.blTest.view().id}"]`);
      const ratio = view.width / view.getBoundingClientRect().width;
      const colors = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        context.clearRect(0, 0, 1, 1);
        context.drawImage(view, x * ratio, y * ratio, 1, 1, 0, 0, 1, 1);
        for (const tile of view.parentElement.querySelectorAll('[data-bl-tiles] canvas')) {
          const left = Number.parseFloat(tile.style.left);
          const top = Number.parseFloat(tile.style.top);
          const tx = x * ratio - left;
          const ty = y * ratio - top;
          if (tx >= 0 && ty >= 0 && tx < tile.width && ty < tile.height)
            context.drawImage(tile, tx, ty, 1, 1, 0, 0, 1, 1);
        }
        colors.push([...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(','));
        await new Promise(requestAnimationFrame);
      }
      return colors;
    },
    { ...PROBE, ms },
  );
// The whole active view as the host shows it (view canvas and damage tiles), RGBA in base64
const snapshot = () =>
  page.evaluate(() => {
    const view = document.querySelector(`canvas[data-bl-view="${window.blTest.view().id}"]`);
    const probe = document.createElement('canvas');
    probe.width = view.width;
    probe.height = view.height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    context.drawImage(view, 0, 0);
    for (const tile of view.parentElement.querySelectorAll('[data-bl-tiles] canvas'))
      context.drawImage(
        tile,
        Number.parseFloat(tile.style.left),
        Number.parseFloat(tile.style.top),
      );
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000)
      text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return btoa(text);
  });
// Pixels that differ by more than 2 in a channel
const differing = (a, b) => {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  if (x.length !== y.length) return Number.POSITIVE_INFINITY;
  let pixels = 0;
  for (let i = 0; i < x.length; i += 4)
    if ([0, 1, 2].some((c) => Math.abs(x[i + c] - y[i + c]) > 2)) pixels++;
  return pixels;
};
const isTop = (color) =>
  color.split(',').every((value, i) => Math.abs(Number(value) - TOP[i]) <= 2);

const setVisible = (visible) =>
  page.evaluate((visible) => window.blTest.view().setVisible(visible), visible);

check('page loaded', await openHost(page, stack.app({ url: siteURL })));
await results.wait('ready');
await waitFor(async () => (await probeFrames(50)).every(isTop), 15000, 200);
await page.waitForTimeout(2000);
const shown = await textures();
const reference = await snapshot();
check('the layers have their tiles', shown !== null && shown >= 20, `${shown} MB`);

// Hidden for a moment, as when switching tabs back and forth: the tiles stay
await setVisible(false);
await page.waitForTimeout(4000);
const brief = await textures();
await setVisible(true);
check(
  'hidden for 4 s, the view keeps its tiles',
  brief !== null && brief >= shown * 0.9,
  `${brief} MB of ${shown} MB`,
);
await page.waitForTimeout(1000);

// Hidden for longer: the tiles go, the pool frees their textures 3 s later
await setVisible(false);
await page.waitForTimeout(15000);
const hidden = await textures();
check(
  'hidden for 15 s, the tiles are released',
  hidden !== null && hidden <= shown * 0.1,
  `${hidden} MB, shown ${shown} MB`,
);

// Shown again: the last frame until the tiles are painted again, never the layers without them
await setVisible(true);
const colors = await probeFrames(3000);
const wrong = colors.filter((color) => !isTop(color));
check(
  'shown again, every frame shows the layers',
  colors.length > 0 && wrong.length === 0,
  `${wrong.length} of ${colors.length} frames other (${[...new Set(wrong)].slice(0, 3).join(' ')})`,
);
const different = differing(reference, await snapshot());
check('shown again, the view looks as before', different === 0, `${different} pixels differ`);
const again = await textures();
check(
  'shown again, the tiles are painted again',
  again !== null && again >= shown * 0.8,
  `${again} MB of ${shown} MB`,
);

// More tabs with the same page, each hidden for 15 s when the next opens: the GPU process gives
// little back to the system, but it reuses what the released tiles had, so it grows by the canvases
// of a tab (about 17 MB here, like a tab of Chromium itself) instead of also by its tiles (45 MB)
if (gpuProcessMB() !== null) {
  const openTab = async () => {
    results.delete('ready');
    await openView(page, siteURL);
    await results.wait('ready');
    await waitFor(async () => (await probeFrames(50)).every(isTop), 15000, 200);
    await page.waitForTimeout(15000);
  };
  await openTab();
  const before = gpuProcessMB();
  await openTab();
  await openTab();
  const after = gpuProcessMB();
  check(
    'two more tabs grow the GPU process by less than 3/4 of their tiles each',
    after - before < shown * 1.5,
    `${before} -> ${after} MB, tiles of one tab ${shown} MB`,
  );
}

await browser.close();
finish();
