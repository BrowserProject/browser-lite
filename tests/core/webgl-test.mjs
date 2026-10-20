// WebGL: the page draws with WebGL 1 and WebGL 2, the engine forwards the GL calls to the WebGL
// of the host browser (platform/wasm/angle) and paints the result into the page. Also the loss
// of the host contexts (webglcontextlost, webglcontextrestored).
//
//   node tests/core/webgl-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  openHost,
  pagePixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Two canvases: left WebGL 1 (blue with a red triangle), right WebGL 2 (green with a yellow triangle)
const PAGE = `<!doctype html><title>WebGL-Test</title><body style="margin:0;background:#fff">
<canvas id="gl1" width="200" height="200" style="position:absolute;left:20px;top:20px"></canvas>
<canvas id="gl2" width="200" height="200" style="position:absolute;left:260px;top:20px"></canvas>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);

function draw(canvas, version) {
  const gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl');
  if (!gl)
    return 'kein-kontext';
  // A fresh context must have no error (else it came from the engine)
  const initialError = gl.getError();
  if (initialError)
    return 'error-at-start:' + initialError;
  const vertexSource = version === 2
    ? '#version 300 es\\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'
    : 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const fragmentSource = version === 2
    ? '#version 300 es\\nprecision mediump float; out vec4 c; void main() { c = vec4(1.0, 1.0, 0.0, 1.0); }'
    : 'precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }';
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error('Link: ' + gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 0.8, -0.8, 0.0, 0.8]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  if (version === 2)
    gl.clearColor(0.0, 0.6, 0.0, 1.0);
  else
    gl.clearColor(0.0, 0.0, 1.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixel = new Uint8Array(4);
  gl.readPixels(100, 100, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const corner = new Uint8Array(4);
  gl.readPixels(5, 5, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner);
  return Array.from(pixel).join(',') + '/' + Array.from(corner).join(',') + '/' + gl.getError();
}

// More functions on an own canvas; returns the list of failures or ok
function features(version) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl', { preserveDrawingBuffer: true });
  const failed = [];
  const expect = (name, ok) => { if (!ok) failed.push(name); };
  const pixel = (x, y) => { const p = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p).join(','); };
  const program = (vs, fs) => {
    const p = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    return p;
  };
  // Full canvas quad with a texture
  const textured = program('attribute vec2 p; varying vec2 t; void main() { t = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }',
    'precision mediump float; varying vec2 t; uniform sampler2D s; void main() { gl_FragColor = texture2D(s, t); }');
  gl.useProgram(textured);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(textured, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  const indices = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 2, 1, 3]), gl.STATIC_DRAW);

  // Texture from data (pixel bottom left green)
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255]));
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  expect('texImage2D-data', pixel(2, 2) === '0,255,0,255' && pixel(13, 13) === '255,255,255,255');

  // Texture from a 2D canvas (purple)
  const source = document.createElement('canvas');
  source.width = source.height = 4;
  const context2d = source.getContext('2d');
  context2d.fillStyle = 'rgb(128, 0, 255)';
  context2d.fillRect(0, 0, 4, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  expect('texImage2D-canvas', pixel(8, 8) === '128,0,255,255');

  // Draw into a texture, with depth/stencil
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, version === 2 ? gl.DEPTH24_STENCIL8 : gl.DEPTH_STENCIL, 16, 16);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
  expect('framebuffer', gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
  gl.clearColor(1, 0.5, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  expect('framebuffer-clear', pixel(4, 4) === '255,128,0,255');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Instancing and vertex arrays (WebGL 1 through extensions)
  if (version === 1) {
    const instanced = gl.getExtension('ANGLE_instanced_arrays');
    const vao = gl.getExtension('OES_vertex_array_object');
    expect('extensions', !!instanced && !!vao && !!gl.getExtension('OES_standard_derivatives'));
    if (instanced)
      instanced.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, 2);
    if (vao)
      vao.bindVertexArrayOES(vao.createVertexArrayOES());
  } else {
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 2);
    gl.bindVertexArray(gl.createVertexArray());
    expect('extensions', !!gl.getExtension('EXT_color_buffer_float'));
    gl.bindVertexArray(null);
  }
  expect('toDataURL', canvas.toDataURL().length > 100);
  const error = gl.getError();
  expect('getError=' + error, error === 0);
  return failed.length ? failed.join('+') : 'ok';
}

// Many contexts at once (Chrome allows only 4 real ones in a worker): each keeps its state, none
// gets lost, none sees the textures of another.
function sharing() {
  const failed = [];
  const contexts = [];
  for (let i = 0; i < 8; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const gl = canvas.getContext(i % 2 ? 'webgl2' : 'webgl');
    // Own state: color, scissor only over the left half
    gl.clearColor(i / 8, 1 - i / 8, 0.5, 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 4, 8);
    contexts.push(gl);
  }
  contexts.forEach((gl, i) => {
    gl.clear(gl.COLOR_BUFFER_BIT);
    const left = new Uint8Array(4), right = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, left);
    gl.readPixels(6, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, right);
    const expected = [Math.round(i / 8 * 255), Math.round((1 - i / 8) * 255), 128, 255];
    if (gl.isContextLost() || left.some((v, k) => Math.abs(v - expected[k]) > 1) || right[3] !== 0)
      failed.push('context' + i + ':' + Array.from(left).join('.') + '/' + right[3]);
  });

  // A texture on unit 5 in one context, the other has nothing there: black
  const program = (gl) => {
    const p = gl.createProgram();
    const sources = ['attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }',
      'precision mediump float; uniform sampler2D s; void main() { gl_FragColor = texture2D(s, vec2(0.5)); }'];
    [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].forEach((type, k) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, sources[k]);
      gl.compileShader(shader);
      gl.attachShader(p, shader);
    });
    gl.linkProgram(p);
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, 's'), 5);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.SCISSOR_TEST);
  };
  const [a, b] = [contexts[0], contexts[2]];
  program(a);
  a.activeTexture(a.TEXTURE5);
  a.bindTexture(a.TEXTURE_2D, a.createTexture());
  a.texImage2D(a.TEXTURE_2D, 0, a.RGBA, 1, 1, 0, a.RGBA, a.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
  a.drawArrays(a.TRIANGLES, 0, 3);
  program(b);
  b.drawArrays(b.TRIANGLES, 0, 3);
  a.drawArrays(a.TRIANGLES, 0, 3);
  const pixelA = new Uint8Array(4), pixelB = new Uint8Array(4);
  a.readPixels(4, 4, 1, 1, a.RGBA, a.UNSIGNED_BYTE, pixelA);
  b.readPixels(4, 4, 1, 1, b.RGBA, b.UNSIGNED_BYTE, pixelB);
  if (pixelA.join() !== '255,0,0,255' || pixelB.join() !== '0,0,0,255')
    failed.push('texture-unit:' + pixelA.join('.') + '/' + pixelB.join('.'));

  // Read a buffer back (WebGL 2)
  const gl2 = contexts[1];
  const buffer = gl2.createBuffer();
  gl2.bindBuffer(gl2.ARRAY_BUFFER, buffer);
  gl2.bufferData(gl2.ARRAY_BUFFER, new Uint8Array([1, 2, 3, 4, 5]), gl2.STATIC_DRAW);
  const back = new Uint8Array(3);
  gl2.getBufferSubData(gl2.ARRAY_BUFFER, 1, back);
  if (back.join() !== '2,3,4')
    failed.push('getBufferSubData:' + back.join('.'));

  // Constant vertex attributes and uniform buffers belong to the context: still there after
  // switching to other contexts, the others do not see them
  const [c, d] = [contexts[3], contexts[5]];
  c.vertexAttrib4f(3, 0.25, 0.5, 0.75, 1);
  const ubo = c.createBuffer();
  c.bindBuffer(c.UNIFORM_BUFFER, ubo);
  c.bufferData(c.UNIFORM_BUFFER, 256, c.STATIC_DRAW);
  c.bindBufferRange(c.UNIFORM_BUFFER, 2, ubo, 0, 64);
  d.clear(d.COLOR_BUFFER_BIT);
  a.clear(a.COLOR_BUFFER_BIT);
  const attribC = Array.from(c.getVertexAttrib(3, c.CURRENT_VERTEX_ATTRIB)).join();
  const attribD = Array.from(d.getVertexAttrib(3, d.CURRENT_VERTEX_ATTRIB)).join();
  const uboC = c.getIndexedParameter(c.UNIFORM_BUFFER_BINDING, 2) === ubo && c.getIndexedParameter(c.UNIFORM_BUFFER_SIZE, 2) === 64;
  const uboD = d.getIndexedParameter(d.UNIFORM_BUFFER_BINDING, 2) === null;
  if (attribC !== '0.25,0.5,0.75,1' || attribD !== '0,0,0,1' || !uboC || !uboD)
    failed.push('attrib-ubo:' + attribC + '/' + attribD + '/' + uboC + '/' + uboD);

  contexts.forEach((gl, i) => {
    const error = gl.getError();
    if (error)
      failed.push('getError' + i + '=' + error);
  });
  return failed.length ? failed.join('+') : 'ok';
}

// Host context lost (GPU reset): the page gets webglcontextlost, after preventDefault
// webglcontextrestored and then draws again. A quiet context only draws again when a new host
// context is already there (quietDraw), and must still be lost.
let quiet;
function startLossTest() {
  quiet = document.createElement('canvas').getContext('webgl');
  quiet.canvas.addEventListener('webglcontextlost', () => result('quietlost', quiet.isContextLost()));
  quiet.clear(quiet.COLOR_BUFFER_BIT);
  result('quietstart', quiet.getError());
  for (const version of [1, 2]) {
    const canvas = document.getElementById('gl' + version);
    const gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl');
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      result('lost' + version, gl.isContextLost());
    });
    canvas.addEventListener('webglcontextrestored', () => result('restored' + version, draw(canvas, version)));
    const frame = () => {
      if (!gl.isContextLost()) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      requestAnimationFrame(frame);
    };
    frame();
  }
  result('losstest', 'ready');
}

function quietDraw() {
  quiet.bindTexture(quiet.TEXTURE_2D, quiet.createTexture());
  quiet.clear(quiet.COLOR_BUFFER_BIT);
  quiet.drawArrays(quiet.TRIANGLES, 0, 3);
}

// toDataURL of a 2D canvas in all three formats
function dataURLs() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return ['image/png', 'image/jpeg', 'image/webp'].map((type) => canvas.toDataURL(type).split(';')[0]).join(',');
}

try {
  result('sharing', sharing());
} catch (e) {
  result('sharing', 'error:' + String(e.message).replace(/\\s+/g, '_'));
}
result('dataurl', dataURLs());

for (const version of [1, 2]) {
  try {
    result('webgl' + version, draw(document.getElementById('gl' + version), version));
  } catch (e) {
    result('webgl' + version, 'error:' + String(e.message).replace(/\\s+/g, '_'));
  }
  try {
    result('features' + version, features(version));
  } catch (e) {
    result('features' + version, 'error:' + String(e.message).replace(/\\s+/g, '_'));
  }
}
const gl = document.createElement('canvas').getContext('webgl');
result('extensions', gl ? gl.getSupportedExtensions().length : -1);
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

const stack = await startStack({ token: 'webgl-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key) => results.wait(key);

await openHost(page, stack.app({ url: siteURL }));

const webgl1 = await result('webgl1');
check(
  'WebGL 1: triangle drawn (readPixels)',
  webgl1?.startsWith('255,0,0,255/0,0,255,255/0'),
  webgl1,
);
const webgl2 = await result('webgl2');
check(
  'WebGL 2: triangle drawn (readPixels)',
  webgl2?.startsWith('255,255,0,255/0,153,0,255/0'),
  webgl2,
);
for (const version of [1, 2]) {
  const features = await result('features' + version);
  check(
    `WebGL ${version}: textures, framebuffers, instancing, toDataURL`,
    features === 'ok',
    features,
  );
}
const sharing = await result('sharing');
check('many contexts (shared host context)', sharing === 'ok', sharing);
const dataURL = await result('dataurl');
check(
  'toDataURL (PNG, JPEG, WebP)',
  dataURL === 'data:image/png,data:image/jpeg,data:image/webp',
  dataURL,
);
const extensions = Number(await result('extensions'));
check('WebGL 1: extensions', extensions > 5, String(extensions));

// The picture must reach the page too
const pixelAt = (x, y) => pagePixel(page, x, y);
const isPicture1 = ({ center1, corner1 }) =>
  center1[0] > 200 && center1[1] < 60 && corner1[2] > 200;
const isPicture2 = ({ center2 }) => center2[0] > 200 && center2[1] > 200 && center2[2] < 60;
async function pagePicture() {
  let picture = null;
  for (const end = Date.now() + 20000; Date.now() < end; await page.waitForTimeout(250)) {
    picture = {
      center1: await pixelAt(120, 130),
      center2: await pixelAt(360, 130),
      corner1: await pixelAt(25, 25),
    };
    if (isPicture1(picture) && isPicture2(picture)) break;
  }
  return picture;
}
const picture = await pagePicture();
check('WebGL 1: picture in the page (red on blue)', isPicture1(picture), JSON.stringify(picture));
check('WebGL 2: picture in the page (yellow)', isPicture2(picture), JSON.stringify(picture));
const shown = await page.evaluate(() => window.blTest.measurements());
check(
  'frames with a new WebGL image are counted (tests/perf)',
  shown?.contentFramesShown > 0 && shown.framesShown >= shown.contentFramesShown,
  JSON.stringify(shown),
);

// The host contexts get lost (like on a GPU reset)
await page.evaluate(() => window.blTest.eval('startLossTest()'));
check('loss test ready', (await result('losstest')) === 'ready');
check('quiet context without errors', (await result('quietstart')) === '0');
await page.evaluate(() => window.blTest.browser.debug.gpu('lose-webgl'));
for (const version of [1, 2]) {
  const lost = await result('lost' + version);
  check(`WebGL ${version}: the page gets webglcontextlost`, lost === 'true', String(lost));
  const restored = await result('restored' + version);
  const expected = version === 2 ? '255,255,0,255/0,153,0,255/0' : '255,0,0,255/0,0,255,255/0';
  check(
    `WebGL ${version}: after webglcontextrestored the page draws again`,
    restored?.startsWith(expected),
    String(restored),
  );
}
await page.evaluate(() => window.blTest.eval('quietDraw()'));
const quietLost = await result('quietlost');
check(
  'quiet context on the new host context: webglcontextlost',
  quietLost === 'true',
  String(quietLost),
);
const restoredPicture = await pagePicture();
check(
  'after the restore: picture in the page',
  isPicture1(restoredPicture) && isPicture2(restoredPicture),
  JSON.stringify(restoredPicture),
);

await screenshot(page, 'webgl');
await browser.close();
finish();
