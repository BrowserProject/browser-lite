// WebGL in workers like Chrome and Firefox (#528): an OffscreenCanvas of a dedicated worker, of a
// nested worker and of a shared worker gets WebGL 1 and WebGL 2 contexts on the worker's own
// thread (engine/src/WorkerGraphics.cpp). The picture reaches the page through
// transferToImageBitmap and through a canvas the page handed over with transferControlToOffscreen
// (with layers since patch 0121, also for the page's own OffscreenCanvas), and a worker that ends
// releases its host contexts (patch 0120).
//
//   node tests/core/webgl-worker-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  pagePixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// Draws a yellow triangle on a cleared background into gl and reads its center and a corner
const DRAW = `
function draw(gl, version, clear) {
  const vs = version === 2
    ? '#version 300 es\\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'
    : 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const fs = version === 2
    ? '#version 300 es\\nprecision mediump float; out vec4 c; void main() { c = vec4(1.0, 1.0, 0.0, 1.0); }'
    : 'precision mediump float; void main() { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); }';
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      return 'shader:' + gl.getShaderInfoLog(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 0.8, -0.8, 0.0, 0.8]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(clear[0], clear[1], clear[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const center = new Uint8Array(4), corner = new Uint8Array(4);
  gl.readPixels(w >> 1, h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);
  gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner);
  return center.join('.') + '/' + corner.join('.') + '/' + gl.getError();
}
const contexts = () => [1, 2].map((version) => {
  const gl = new OffscreenCanvas(16, 16).getContext(version === 2 ? 'webgl2' : 'webgl');
  return gl ? draw(gl, version, [0, 0, 1]) : 'none';
}).join(',');
`;

// Dedicated worker: both versions, a bitmap for the page, the page's canvas, a nested worker
const WORKER = `${DRAW}
onmessage = (event) => {
  const { canvas, nested } = event.data;
  if (nested) {
    postMessage({ nested: contexts() });
    return;
  }
  postMessage({ contexts: contexts() });
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2');
  if (gl) {
    draw(gl, 2, [0, 0, 1]);
    const bitmap = gl.canvas.transferToImageBitmap();
    postMessage({ bitmap }, [bitmap]);
  } else
    postMessage({ bitmap: 'none' });
  // The page's canvas: green with the yellow triangle
  const shown = canvas.getContext('webgl2');
  postMessage({ placeholder: shown ? draw(shown, 2, [0, 0.6, 0]) : 'none' });
  const inner = new Worker('worker.js');
  inner.onmessage = (e) => postMessage({ nested: e.data.nested });
  inner.postMessage({ nested: true });
};`;

const SHARED = `${DRAW}
onconnect = (event) => event.ports[0].postMessage(contexts());`;

const PAGE = `<!doctype html><title>WebGL worker test</title><body style="margin:0;background:#fff">
<canvas id="placeholder" width="200" height="200" style="position:absolute;left:20px;top:20px"></canvas>
<canvas id="main" width="200" height="200" style="position:absolute;left:260px;top:20px"></canvas>
<script>
// A canvas handed to an OffscreenCanvas of the page itself (2D)
const own = document.getElementById('main').transferControlToOffscreen().getContext('2d');
own.fillStyle = 'rgb(200, 0, 200)';
own.fillRect(0, 0, 200, 200);
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const worker = new Worker('worker.js');
worker.onerror = (e) => result('contexts', 'error:' + e.message);
worker.onmessage = ({ data }) => {
  if (data.contexts) result('contexts', data.contexts);
  if (data.placeholder) result('placeholder', data.placeholder);
  if (data.nested) result('nested', data.nested);
  if (data.bitmap === 'none') result('bitmap', 'none');
  else if (data.bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    context.drawImage(data.bitmap, 0, 0);
    // Near the bottom inside the triangle, near the top outside of it
    result('bitmap', context.getImageData(8, 13, 1, 1).data.join('.') + '/' + context.getImageData(8, 1, 1, 1).data.join('.'));
  }
};
const offscreen = document.getElementById('placeholder').transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);
const shared = new SharedWorker('shared.js');
shared.port.onmessage = ({ data }) => result('shared', data);

// A worker that ends after drawing; the test counts the host contexts that stay
let round = 0;
function shortWorker() {
  const short = new Worker('worker.js');
  short.onmessage = ({ data }) => {
    short.terminate();
    result('short' + ++round, data.nested);
  };
  short.postMessage({ nested: true });
}
</script>`;

const { url: siteURL } = await serve((req, res) => {
  const body = req.url.endsWith('/worker.js')
    ? WORKER
    : req.url.endsWith('/shared.js')
      ? SHARED
      : PAGE;
  const type = req.url.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type }).end(body);
});

const stack = await startStack({ token: 'webgl-worker-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(page);
const result = (key) => results.wait(key);

await openHost(page, stack.app({ url: siteURL }));

// Yellow center on blue, no GL error
const drawn = (value) => /^255\.255\.0\.255\/0\.0\.255\.255\/0$/.test(value);
const contexts = (await result('contexts')) ?? '';
const [webgl1, webgl2] = contexts.split(',');
check('dedicated worker: WebGL 1 context draws (readPixels)', drawn(webgl1), contexts);
check('dedicated worker: WebGL 2 context draws (readPixels)', drawn(webgl2), contexts);
const nested = (await result('nested')) ?? '';
check('nested worker: WebGL 1 and 2 draw', nested.split(',').every(drawn), nested);
const shared = (await result('shared')) ?? '';
check(
  'shared worker: WebGL 1 and 2 draw',
  shared.split(',').length === 2 && shared.split(',').every(drawn),
  shared,
);
const bitmap = await result('bitmap');
check(
  'transferToImageBitmap of a worker WebGL canvas reaches the page upright',
  bitmap === '255.255.0.255/0.0.255.255',
  bitmap,
);
const placeholder = await result('placeholder');
check(
  "the page's transferred canvas: WebGL 2 in the worker",
  /^255\.255\.0\.255\/0\.153\.0\.255\/0$/.test(placeholder ?? ''),
  placeholder,
);
let shown = null;
const picture = await waitFor(async () => {
  shown = { center: await pagePixel(page, 120, 130), corner: await pagePixel(page, 25, 25) };
  return near(shown.center, [255, 255, 0]) && near(shown.corner, [0, 153, 0]);
});
check("the worker's picture in the page (yellow on green)", picture, JSON.stringify(shown));
let ownShown = null;
const ownPicture = await waitFor(async () =>
  near((ownShown = await pagePixel(page, 360, 120)), [200, 0, 200]),
);
check(
  "a page's own OffscreenCanvas of a transferred canvas in the page",
  ownPicture,
  JSON.stringify(ownShown),
);

// Host contexts in the engine's Web Workers that are not lost; the first call installs the count
function liveHostContexts() {
  if (typeof OffscreenCanvas === 'undefined' || typeof WebGLRenderingContext === 'undefined')
    return [0, 0];
  if (!self.blHostContexts) {
    self.blHostContexts = [];
    const getContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (type, ...rest) {
      const context = getContext.call(this, type, ...rest);
      if (context && /^webgl/.test(type)) self.blHostContexts.push(context);
      return context;
    };
  }
  return [self.blHostContexts.length, self.blHostContexts.filter((c) => !c.isContextLost()).length];
}
const hostContexts = async () => {
  const counts = await Promise.all(
    page
      .workers()
      .map((worker) =>
        Promise.race([
          worker.evaluate(liveHostContexts).catch(() => [0, 0]),
          new Promise((resolve) => setTimeout(() => resolve([0, 0]), 3000)),
        ]),
      ),
  );
  return counts.reduce(([made, live], [m, l]) => [made + m, live + l], [0, 0]);
};
const ROUNDS = 3;
const [madeBefore, liveBefore] = await hostContexts();
for (let round = 1; round <= ROUNDS; round++) {
  // Also the Web Workers loaded since
  await hostContexts();
  await page.evaluate(() => window.blTest.eval('shortWorker()'));
  const short = (await result(`short${round}`)) ?? '';
  check(`short worker ${round}: WebGL 1 and 2 draw`, short.split(',').every(drawn), short);
}
let counts = [0, 0];
const released = await waitFor(async () => {
  counts = await hostContexts();
  return counts[1] <= liveBefore;
}, 10000);
check(
  'ended workers release their host contexts',
  // At least one of them ran in a Web Worker that counts (Firefox loads more of them meanwhile)
  released && counts[0] - madeBefore >= 2,
  `made ${counts[0] - madeBefore} in ${ROUNDS} workers, ${counts[1] - liveBefore} left of them`,
);

await screenshot(page, 'webgl-worker');
await browser.close();
finish();
