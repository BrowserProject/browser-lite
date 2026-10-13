// End-to-End Test fuer Compositing mit Ebenen (?compositing=1): Farben der
// Kacheln, CSS-Animation (transform) ohne neues Malen, fixierte Leiste beim
// Scrollen, Blur-Filter und WebGL-Canvas in einer Ebene.
//
//   cd tests/e2e && node compositing-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'compositing-token-0123456789abcdef';
const RELAY_PORT = 15811;
const UI_PORT = 15812;
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

// Oben links drei Farbfelder, darunter ein Kasten, der per CSS-Animation hin und
// her faehrt, rechts ein unscharfer Kasten und ein WebGL-Canvas. Die Leiste oben
// ist fixiert, die Seite ist lang genug zum Scrollen.
const PAGE = `<!doctype html><title>Compositing-Test</title>
<style>
  body { margin: 0; background: #fff; height: 3000px; }
  #bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: rgb(255, 128, 0); z-index: 10; }
  .box { position: absolute; width: 60px; height: 60px; }
  #mover { position: absolute; top: 160px; left: 20px; width: 40px; height: 40px; background: rgb(0, 0, 0); will-change: transform; animation: move 1s linear infinite alternate; }
  @keyframes move { from { transform: translateX(0); } to { transform: translateX(300px); } }
  #blur { position: absolute; top: 60px; left: 500px; width: 100px; height: 100px; background: rgb(0, 0, 255); filter: blur(10px); }
  #fade { top: 240px; left: 20px; background: rgb(255, 0, 0); opacity: 0.5; will-change: opacity; }
  canvas { position: absolute; top: 240px; left: 500px; }
</style>
<div id="bar"></div>
<div class="box" style="top:60px;left:20px;background:rgb(255,0,0)"></div>
<div class="box" style="top:60px;left:100px;background:rgb(0,255,0)"></div>
<div class="box" style="top:60px;left:180px;background:rgb(0,0,255)"></div>
<div id="mover"></div>
<div id="blur"></div>
<div class="box" id="fade"></div>
<canvas id="gl" width="80" height="80"></canvas>
<div style="position:absolute;top:1000px;left:20px;width:60px;height:60px;background:rgb(0,128,0)"></div>
<script>
const gl = document.getElementById('gl').getContext('webgl');
if (gl) {
  gl.clearColor(1, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
let frames = 0;
const count = () => { frames++; requestAnimationFrame(count); };
requestAnimationFrame(count);
setInterval(() => console.log('RESULT frames=' + frames), 500);
console.log('RESULT ready=1');
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
// Auch bei Abbruch (Zeitlimit) die Hilfsprozesse beenden
process.on('exit', () => {
  relay.kill();
  ui.kill();
});

// Headless Chromium hat sonst kein WebGL
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = new Map();
const logs = [];
page.on('console', (msg) => {
  const text = msg.text();
  const match = /RESULT (\w+)=(\S*)/.exec(text);
  if (match)
    results.set(match[1], match[2]);
  else {
    logs.push(text);
    if (process.env.E2E_VERBOSE)
      console.log('   ', text);
  }
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

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL, compositing: '1', debug: '1', env: process.env.COMP_ENV || '' });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('Seite geladen', await result('ready') === '1');

const pixelAt = (x, y) => page.evaluate(([x, y]) => window.blPagePixel(x, y), [x, y]);
const near = (pixel, rgb, tolerance = 40) => pixel && rgb.every((value, i) => Math.abs(pixel[i] - value) <= tolerance);
// Warten, bis ein Bild mit Inhalt da ist (Kacheln werden im Hintergrund gemalt)
async function waitFor(condition, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition())
      return true;
    await page.waitForTimeout(200);
  }
  return false;
}

await waitFor(async () => near(await pixelAt(50, 90), [255, 0, 0]));
await page.screenshot({ path: path.join(root, 'build', 'e2e-compositing-top.png') }).catch(() => {});
const red = await pixelAt(50, 90), green = await pixelAt(130, 90), blue = await pixelAt(210, 90);
check('Farben stimmen (rot, gruen, blau)', near(red, [255, 0, 0]) && near(green, [0, 255, 0]) && near(blue, [0, 0, 255]), JSON.stringify({ red, green, blue }));
const bar = await pixelAt(500, 20);
check('Fixierte Leiste oben', near(bar, [255, 128, 0]), JSON.stringify(bar));
check('Compositing ist an', !logs.some((line) => /Compositing aus/.test(line)));

// Die Animation laeuft: der schwarze Kasten ist mal links, mal weiter rechts
const positions = new Set();
for (let i = 0; i < 20; i++) {
  for (const x of [40, 140, 240, 340]) {
    const pixel = await pixelAt(x, 180);
    if (near(pixel, [0, 0, 0], 60))
      positions.add(x);
  }
  await page.waitForTimeout(100);
}
check('CSS-Animation (transform) bewegt sich', positions.size >= 2, JSON.stringify([...positions]));

const fade = await pixelAt(50, 270);
check('Halb durchsichtig (opacity)', near(fade, [255, 128, 128], 50), JSON.stringify(fade));
const blurCenter = await pixelAt(550, 110), blurEdge = await pixelAt(500, 110);
check('Blur-Filter', near(blurCenter, [0, 0, 255], 60) && blurEdge[2] > 60 && blurEdge[0] > 60, JSON.stringify({ blurCenter, blurEdge }));
let yellow = null;
await waitFor(async () => near(yellow = await pixelAt(540, 280), [255, 255, 0]), 10000);
check('WebGL-Canvas in einer Ebene', near(yellow, [255, 255, 0]), JSON.stringify(yellow));

const framesBefore = Number(await result('frames'));
await page.waitForTimeout(2000);
results.delete('frames');
const framesAfter = Number(await result('frames'));
check('requestAnimationFrame laeuft weiter', framesAfter - framesBefore > 10, `${framesBefore} -> ${framesAfter}`);

// Scrollen: Inhalt wandert, die Leiste bleibt
await page.mouse.move(500, 400);
await page.mouse.wheel(0, 900);
let scrolled = null;
await waitFor(async () => near(scrolled = await pixelAt(50, 130), [0, 128, 0]), 10000);
check('Scrollen verschiebt den Inhalt', near(scrolled, [0, 128, 0]), JSON.stringify(scrolled));
check('Leiste bleibt beim Scrollen', near(await pixelAt(500, 20), [255, 128, 0]));

await page.screenshot({ path: path.join(root, 'build', 'e2e-compositing.png') }).catch(() => {});
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
