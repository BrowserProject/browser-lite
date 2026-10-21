// Damage tracking in the compositor (#220): a frame without a change is neither composited nor
// shown. Every step of a page with animation, a moving blur filter (cached filtered layers of
// patch 0036), backdrop-filter, a fixed bar while scrolling, video, WebGL, a repaint while wheel
// frames come (patch 0045: the damage goes with the tiles) and pinch zoom must look exactly like
// with every frame composited and shown (BL_DAMAGE=0, until #220 is confirmed): 0 different
// pixels in each of 3 runs, and while nothing visible changes (an animation off the view) no new
// frame is shown. The same for the measurement arm that composites only the damage into a target
// per view (BL_DAMAGE=target).
//
//   node tests/core/damage-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  SWIFTSHADER,
  TIMEOUT,
  buildDir,
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  launch,
  near,
  openHost,
  pagePixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

const RUNS = 3;

timeLimit(TIMEOUT + 600000);

// Top: a box with a paused CSS animation, a blurred box, stripes under a backdrop-filter, the
// video, a WebGL canvas and a box painted by a worklet. A box off the view spins all the time.
// The bar is fixed, the page is long enough to scroll, the rows have text.
const PAGE = `<!doctype html><title>Damage test</title>
<style>
  body { margin: 0; height: 3000px; background: #fff; font: 16px sans-serif; }
  #bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: rgba(255, 128, 0, 0.8); z-index: 10; }
  #mover { position: absolute; top: 60px; left: 20px; width: 60px; height: 60px; background: rgb(0, 96, 192); animation: move 1s linear infinite alternate paused; }
  @keyframes move { to { transform: translateX(300px) rotate(45deg); } }
  #blur { position: absolute; top: 60px; left: 420px; width: 100px; height: 100px; background: rgb(192, 0, 192); filter: blur(8px); }
  #stripes { position: absolute; top: 200px; left: 20px; width: 300px; height: 120px; background: repeating-linear-gradient(90deg, #f00 0 20px, #0f0 20px 40px); }
  #glass { position: absolute; top: 220px; left: 60px; width: 200px; height: 80px; backdrop-filter: blur(6px); background: rgba(255, 255, 255, 0.2); }
  #spinner { position: absolute; top: 100px; left: -400px; width: 100px; height: 100px; background: #000; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  video { position: absolute; top: 200px; left: 420px; width: 160px; height: 120px; }
  canvas { position: absolute; top: 360px; left: 20px; }
  #slow { position: absolute; top: 360px; left: 220px; width: 100px; height: 100px; background-image: paint(slow); --color: rgb(200, 0, 0); }
  .row { margin: 0 0 8px 640px; height: 40px; background: #eee; }
</style>
<div id="bar"></div>
<div id="mover"></div>
<div id="blur"></div>
<div id="stripes"></div>
<div id="glass"></div>
<div id="spinner"></div>
<video id="video" src="/clip.webm" muted playsinline></video>
<canvas id="gl" width="160" height="120"></canvas>
<div id="slow"></div>
${Array.from({ length: 60 }, (_, i) => `<div class="row">Row ${i}</div>`).join('')}
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
video.addEventListener('ended', () => result('ended', '1'));
video.play().catch((e) => result('ended', e.name));
const gl = document.getElementById('gl').getContext('webgl');
const shader = (type, source) => {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  return s;
};
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); }'));
gl.linkProgram(program);
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0, 0.5]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
window.glDraw = (r, g, b) => {
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};
glDraw(0, 0, 0);
CSS.paintWorklet.addModule('/slow.js').then(() => result('ready', '1'), (e) => result('ready', e.name));
</script>`;

// Paints the box in --color and takes 600 ms for each new color: the rendering update then stays
// that long between the damage of the box and its tiles, on the engine thread
const SLOW_WORKLET = `let last = '';
registerPaint('slow', class {
  static get inputProperties() { return ['--color']; }
  paint(ctx, size, props) {
    const color = String(props.get('--color')).trim();
    if (color !== last) {
      last = color;
      for (const end = Date.now() + 600; Date.now() < end; );
    }
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size.width, size.height);
  }
});`;

// WebM (VP8) of a canvas that turns red, green, blue and yellow, 0.5 s each: the last frame is
// yellow, so the frame shown after the end is the same in every run
async function colorClip(browser) {
  const recorder = await browser.newPage();
  await recorder.goto('about:blank');
  const bytes = await recorder.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    const media = new MediaRecorder(canvas.captureStream(25), {
      mimeType: 'video/webm;codecs=vp8',
    });
    const chunks = [];
    media.ondataavailable = (e) => chunks.push(e.data);
    const colors = ['#e00000', '#00c000', '#0000e0', '#e0e000'];
    const start = performance.now();
    const paint = () => {
      const index = Math.min(3, Math.floor((performance.now() - start) / 500));
      context.fillStyle = colors[index];
      context.fillRect(0, 0, 160, 120);
    };
    paint();
    const timer = setInterval(paint, 40);
    media.start(500);
    await new Promise((resolve) => setTimeout(resolve, 2400));
    await new Promise((resolve) => {
      media.onstop = resolve;
      media.stop();
    });
    clearInterval(timer);
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await recorder.close();
  return Buffer.from(bytes);
}

const browser = await launch({ args: SWIFTSHADER });
const CLIP = await colorClip(browser);
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/clip.webm') res.writeHead(200, { 'Content-Type': 'video/webm' }).end(CLIP);
  else if (req.url === '/slow.js')
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SLOW_WORKLET);
  else res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});
const stack = await startStack({ token: 'damage-token-0123456789abcdef' });

/** All pixels of the active view (RGBA), like debug.pagePixel reads them. */
const snapshot = (page) =>
  page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
      (c) => c.style.display !== 'none',
    );
    const rect = canvas.getBoundingClientRect();
    const probe = document.createElement('canvas');
    probe.width = Math.ceil(rect.width);
    probe.height = Math.ceil(rect.height);
    const context = probe.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000)
      text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return { width: probe.width, height: probe.height, data: btoa(text) };
  });

/** The view once two snapshots 300 ms apart are equal (tiles painted, filters settled). */
async function settled(page) {
  await page.waitForTimeout(400);
  let last = await snapshot(page);
  for (const end = Date.now() + 10000; Date.now() < end; ) {
    await page.waitForTimeout(300);
    const next = await snapshot(page);
    if (next.data === last.data) return next;
    last = next;
  }
  return last;
}

/** A snapshot as PNG in build/ (CI artifact), drawn by the browser. */
async function savePng(shot, name) {
  const page = await browser.newPage();
  const png = await page.evaluate((shot) => {
    const canvas = document.createElement('canvas');
    canvas.width = shot.width;
    canvas.height = shot.height;
    const bytes = Uint8ClampedArray.from(atob(shot.data), (c) => c.charCodeAt(0));
    canvas.getContext('2d').putImageData(new ImageData(bytes, shot.width, shot.height), 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, shot);
  await page.close();
  fs.writeFileSync(path.join(buildDir, `e2e-${name}.png`), Buffer.from(png, 'base64'));
}

/** Number of pixels that differ and their bounding box. */
function difference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { pixels: -1 };
  const x = Buffer.from(a.data, 'base64');
  const y = Buffer.from(b.data, 'base64');
  let pixels = 0;
  const box = { left: a.width, top: a.height, right: -1, bottom: -1 };
  for (let i = 0; i < x.length; i += 4) {
    if (x[i] === y[i] && x[i + 1] === y[i + 1] && x[i + 2] === y[i + 2]) continue;
    pixels++;
    const px = (i / 4) % a.width;
    const py = Math.floor(i / 4 / a.width);
    box.left = Math.min(box.left, px);
    box.top = Math.min(box.top, py);
    box.right = Math.max(box.right, px);
    box.bottom = Math.max(box.bottom, py);
  }
  return pixels ? { pixels, box } : { pixels };
}

// The steps after the load, each shown and then read once settled
const STEPS = [
  [
    'animation',
    async ({ page, result }) => {
      await evalPage(
        page,
        `(() => {
          const mover = document.getElementById('mover');
          mover.style.animationPlayState = 'running';
          setTimeout(() => {
            const animation = mover.getAnimations()[0];
            animation.pause();
            animation.currentTime = 250;
            result('animated', '1');
          }, 1000);
        })()`,
      );
      await result('animated');
    },
  ],
  [
    'filter moves',
    async ({ page, result }) => {
      await evalPage(
        page,
        `document.getElementById('blur').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 600, fill: 'forwards' }).finished.then(() => result('filtered', '1'))`,
      );
      await result('filtered');
    },
  ],
  [
    'filter between pixels',
    ({ page }) =>
      evalPage(
        page,
        `(() => {
          const blur = document.getElementById('blur');
          blur.getAnimations().forEach((animation) => animation.cancel());
          blur.style.transform = 'translateX(37.5px)';
        })()`,
      ),
  ],
  [
    'backdrop changes',
    ({ page }) =>
      evalPage(
        page,
        `document.getElementById('stripes').style.background = 'repeating-linear-gradient(90deg, #00f 0 20px, #ff0 20px 40px)'`,
      ),
  ],
  [
    'backdrop moves',
    ({ page }) =>
      evalPage(page, `document.getElementById('glass').style.transform = 'translate(40px, 10px)'`),
  ],
  ['webgl', ({ page }) => evalPage(page, 'glDraw(0.2, 0.6, 0.9)')],
  ['webgl again', ({ page }) => evalPage(page, 'glDraw(0.9, 0.3, 0.1)')],
  ['scroll', ({ page }) => evalPage(page, 'scrollTo(0, 500)')],
  ['scroll a bit', ({ page }) => evalPage(page, 'scrollBy(0, 123)')],
  [
    'wheel',
    async ({ page, origin }) => {
      await page.mouse.move(origin.x + 500, origin.y + 400);
      await page.mouse.wheel(0, 300);
    },
  ],
  ['scroll back', ({ page }) => evalPage(page, 'scrollTo(0, 0)')],
  [
    'repaint while wheel frames come',
    // Wheel frames of the scrolling thread before and while the rendering update paints the box
    // (the scrolling tree is out of sync with the engine thread then): the frame that brings its
    // tiles afterwards must still have their damage
    async ({ page, origin }) => {
      await page.mouse.move(origin.x + 700, origin.y + 600);
      for (let i = 0; i < 12; i++) {
        if (i === 3)
          await evalPage(
            page,
            `document.getElementById('slow').style.setProperty('--color', 'rgb(0, 160, 80)')`,
          );
        await page.mouse.wheel(0, 2);
        await page.waitForTimeout(40);
      }
    },
  ],
  // The pinch starts from the top: the fixed bar after a zoom from elsewhere depends on timing
  ['scroll back again', ({ page }) => evalPage(page, 'scrollTo(0, 0)')],
  [
    'pinch',
    // Touchpad pinch (Ctrl + fractional wheel deltas) to scale 2 around the top left corner, in
    // fixed steps: the gesture of CDP depends on timing
    async ({ page, origin }) => {
      await page.mouse.move(origin.x, origin.y);
      await page.keyboard.down('Control');
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -25 * Math.LN2);
      await page.keyboard.up('Control');
    },
  ],
  [
    'wheel while zoomed',
    async ({ page, origin }) => {
      await page.mouse.move(origin.x + 500, origin.y + 400);
      await page.mouse.wheel(0, 200);
    },
  ],
];

/** One engine through all steps: snapshots by step and frames shown while nothing changed. */
async function scenario(env, run) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const results = collect(page);
  const result = (key) => results.wait(key, 30000);
  await openHost(page, stack.app({ url: siteURL, compositing: '1', env }));
  const shots = new Map();
  const info = { ready: (await result('ready')) === '1' };
  info.ended = (await result('ended')) === '1';
  shots.set('load', await settled(page));
  info.video = await pagePixel(page, 500, 260);
  // The spinner off the view keeps the compositor busy, nothing visible changes
  const shown = () => page.evaluate(() => window.blTest.measurements()?.framesShown ?? null);
  const before = await shown();
  await page.waitForTimeout(1500);
  info.idleFrames = (await shown()) - before;
  const origin = await canvasOrigin(page);
  info.states = {};
  for (const [index, [name, step]] of STEPS.entries()) {
    await step({ page, result, origin });
    shots.set(name, await settled(page));
    await evalPage(
      page,
      `result('state${index}', [visualViewport.scale, visualViewport.pageLeft, visualViewport.pageTop].join())`,
    );
    info.states[name] = await result(`state${index}`);
  }
  await screenshot(page, `damage-${env || 'skip'}-${run}`.replace('BL_DAMAGE=', ''));
  await context.close();
  return { shots, info };
}

// The damage uses until #220 is confirmed: skipping frames without a change (default) and
// compositing only the damage into a target (BL_DAMAGE=target)
const ARMS = [
  ['skip', ''],
  ['target', 'BL_DAMAGE=target'],
];

for (let run = 1; run <= RUNS; run++) {
  const full = await scenario('BL_DAMAGE=0', run);
  for (const [arm, env] of ARMS) {
    const on = await scenario(env, run);
    const label = `run ${run}, ${arm}`;
    check(
      `${label}: pages ready, video played to its end`,
      on.info.ready && full.info.ready && on.info.ended && full.info.ended,
      JSON.stringify({ on: on.info, full: full.info }),
    );
    check(
      `${label}: last video frame shown (yellow)`,
      near(on.info.video, [224, 224, 0], 60) && near(full.info.video, [224, 224, 0], 60),
      JSON.stringify([on.info.video, full.info.video]),
    );
    // With every frame shown the engine still counts only frames with a change (tests/perf)
    check(
      `${label}: no new frame while nothing visible changes`,
      on.info.idleFrames <= 2 && full.info.idleFrames <= 2,
      `${on.info.idleFrames} and ${full.info.idleFrames} frames with a change in 1.5 s`,
    );
    for (const [name, shot] of on.shots) {
      const diff = difference(shot, full.shots.get(name));
      check(
        `${label}: ${name} like the whole view`,
        diff.pixels === 0,
        JSON.stringify({ ...diff, on: on.info.states[name], full: full.info.states[name] }),
      );
      if (diff.pixels) {
        const file = `damage-${run}-${arm}-${name.replaceAll(' ', '-')}`;
        await savePng(shot, `${file}-on`);
        await savePng(full.shots.get(name), `${file}-full`);
      }
    }
  }
}

await browser.close();
finish();
