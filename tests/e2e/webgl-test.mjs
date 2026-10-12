// End-to-End Test fuer WebGL: die Seite zeichnet mit WebGL 1 und WebGL 2,
// die Engine leitet die GL-Aufrufe an das WebGL des Host-Browsers weiter
// (platform/wasm/angle) und malt das Ergebnis in die Seite.
//
//   cd tests/e2e && node webgl-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'webgl-token-0123456789abcdef';
const RELAY_PORT = 15801;
const UI_PORT = 15802;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

// Zwei Canvas: links WebGL 1 (blau mit rotem Dreieck), rechts WebGL 2 (gruen mit gelbem Dreieck)
const PAGE = `<!doctype html><title>WebGL-Test</title><body style="margin:0;background:#fff">
<canvas id="gl1" width="200" height="200" style="position:absolute;left:20px;top:20px"></canvas>
<canvas id="gl2" width="200" height="200" style="position:absolute;left:260px;top:20px"></canvas>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);

function draw(canvas, version) {
  const gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl');
  if (!gl)
    return 'kein-kontext';
  // Ein frischer Kontext darf keinen Fehler haben (sonst kam er aus der Engine)
  const initialError = gl.getError();
  if (initialError)
    return 'fehler-beim-start:' + initialError;
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

// Mehr Funktionen auf einem eigenen Canvas; Rueckgabe: Liste der Fehler oder ok
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
  // Vollbild-Viereck mit Textur
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

  // Textur aus Daten (Pixel unten links gruen)
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255]));
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  expect('texImage2D-daten', pixel(2, 2) === '0,255,0,255' && pixel(13, 13) === '255,255,255,255');

  // Textur aus einem 2D-Canvas (lila)
  const source = document.createElement('canvas');
  source.width = source.height = 4;
  const context2d = source.getContext('2d');
  context2d.fillStyle = 'rgb(128, 0, 255)';
  context2d.fillRect(0, 0, 4, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  expect('texImage2D-canvas', pixel(8, 8) === '128,0,255,255');

  // In eine Textur zeichnen, mit Tiefe/Stencil
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

  // Instancing und Vertex Arrays (WebGL 1 ueber Erweiterungen)
  if (version === 1) {
    const instanced = gl.getExtension('ANGLE_instanced_arrays');
    const vao = gl.getExtension('OES_vertex_array_object');
    expect('erweiterungen', !!instanced && !!vao && !!gl.getExtension('OES_standard_derivatives'));
    if (instanced)
      instanced.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, 2);
    if (vao)
      vao.bindVertexArrayOES(vao.createVertexArrayOES());
  } else {
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 2);
    gl.bindVertexArray(gl.createVertexArray());
    expect('erweiterungen', !!gl.getExtension('EXT_color_buffer_float'));
    gl.bindVertexArray(null);
  }
  expect('toDataURL', canvas.toDataURL().length > 100);
  const error = gl.getError();
  expect('getError=' + error, error === 0);
  return failed.length ? failed.join('+') : 'ok';
}

// Viele Kontexte gleichzeitig (Chrome erlaubt in einem Worker nur 4 echte):
// jeder behaelt seinen Zustand, keiner geht verloren, keiner sieht Texturen
// eines anderen.
function sharing() {
  const failed = [];
  const contexts = [];
  for (let i = 0; i < 8; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const gl = canvas.getContext(i % 2 ? 'webgl2' : 'webgl');
    // Eigener Zustand: Farbe, Scissor nur ueber die linke Haelfte
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
      failed.push('kontext' + i + ':' + Array.from(left).join('.') + '/' + right[3]);
  });

  // Textur im einen Kontext auf Einheit 5, der andere hat dort nichts: schwarz
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
    failed.push('textur-einheit:' + pixelA.join('.') + '/' + pixelB.join('.'));

  // Puffer zuruecklesen (WebGL 2)
  const gl2 = contexts[1];
  const buffer = gl2.createBuffer();
  gl2.bindBuffer(gl2.ARRAY_BUFFER, buffer);
  gl2.bufferData(gl2.ARRAY_BUFFER, new Uint8Array([1, 2, 3, 4, 5]), gl2.STATIC_DRAW);
  const back = new Uint8Array(3);
  gl2.getBufferSubData(gl2.ARRAY_BUFFER, 1, back);
  if (back.join() !== '2,3,4')
    failed.push('getBufferSubData:' + back.join('.'));

  contexts.forEach((gl, i) => {
    const error = gl.getError();
    if (error)
      failed.push('getError' + i + '=' + error);
  });
  return failed.length ? failed.join('+') : 'ok';
}

// toDataURL beim 2D-Canvas in allen drei Formaten
function dataURLs() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return ['image/png', 'image/jpeg', 'image/webp'].map((type) => canvas.toDataURL(type).split(';')[0]).join(',');
}

try {
  result('sharing', sharing());
} catch (e) {
  result('sharing', 'fehler:' + String(e.message).replace(/\\s+/g, '_'));
}
result('dataurl', dataURLs());

for (const version of [1, 2]) {
  try {
    result('webgl' + version, draw(document.getElementById('gl' + version), version));
  } catch (e) {
    result('webgl' + version, 'fehler:' + String(e.message).replace(/\\s+/g, '_'));
  }
  try {
    result('features' + version, features(version));
  } catch (e) {
    result('features' + version, 'fehler:' + String(e.message).replace(/\\s+/g, '_'));
  }
}
const gl = document.createElement('canvas').getContext('webgl');
result('extensions', gl ? gl.getSupportedExtensions().length : -1);
</script>`;

const site = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}
const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});

// Headless Chromium hat sonst kein WebGL
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  else if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
async function result(key) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);

const webgl1 = await result('webgl1');
check('WebGL 1: Dreieck gezeichnet (readPixels)', webgl1?.startsWith('255,0,0,255/0,0,255,255/0'), webgl1);
const webgl2 = await result('webgl2');
check('WebGL 2: Dreieck gezeichnet (readPixels)', webgl2?.startsWith('255,255,0,255/0,153,0,255/0'), webgl2);
for (const version of [1, 2]) {
  const features = await result('features' + version);
  check(`WebGL ${version}: Texturen, Framebuffer, Instancing, toDataURL`, features === 'ok', features);
}
const sharing = await result('sharing');
check('Viele Kontexte (geteilter Host-Kontext)', sharing === 'ok', sharing);
const dataURL = await result('dataurl');
check('toDataURL (PNG, JPEG, WebP)', dataURL === 'data:image/png,data:image/jpeg,data:image/webp', dataURL);
const extensions = Number(await result('extensions'));
check('WebGL 1: Erweiterungen', extensions > 5, String(extensions));

// Das Bild muss auch in der Seite ankommen
async function pixelAt(x, y) {
  return page.evaluate(([x, y]) => {
    const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const [r, g, b] = canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
    return [r, g, b];
  }, [x, y]);
}
let center1 = null, center2 = null, corner1 = null;
const end = Date.now() + 20000;
while (Date.now() < end) {
  center1 = await pixelAt(120, 130);
  center2 = await pixelAt(360, 130);
  corner1 = await pixelAt(25, 25);
  if (center1[0] > 200 && center1[2] < 60 && center2[0] > 200 && center2[1] > 200 && corner1[2] > 200)
    break;
  await page.waitForTimeout(250);
}
check('WebGL 1: Bild in der Seite (rot auf blau)', center1[0] > 200 && center1[1] < 60 && corner1[2] > 200, JSON.stringify({ center1, corner1 }));
check('WebGL 2: Bild in der Seite (gelb)', center2[0] > 200 && center2[1] > 200 && center2[2] < 60, JSON.stringify(center2));

await page.screenshot({ path: path.join(root, 'build', 'e2e-webgl.png') }).catch(() => {});
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
