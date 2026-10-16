// End-to-End Test fuer Compositing mit Ebenen (?compositing=1): Farben der
// Kacheln, CSS-Animation (transform) ohne neues Malen, fixierte Leiste beim
// Scrollen, Blur-Filter und WebGL-Canvas in einer Ebene. Animation und Scrollen
// laufen weiter, waehrend das JS der Seite blockiert (Compositor-/Scroll-Thread).
//
//   cd tests/e2e && node compositing-test.mjs [engine-ordner]
import { SWIFTSHADER, check, collect, finish, launch, screenshot, serve, startStack, timeLimit } from './harness.mjs';

timeLimit();

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
<div id="late" style="position:absolute;top:1000px;left:20px;width:60px;height:60px;background:rgb(0,128,0)"></div>
<div id="trap" style="position:absolute;top:1200px;left:20px;width:300px;height:200px;background:rgb(200,200,200)"></div>
<div id="box" style="position:absolute;top:1200px;left:400px;width:200px;height:200px;overflow:auto"><div style="height:300px;background:rgb(255,0,255)"></div><div style="height:700px;background:rgb(0,255,255)"></div></div>
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
// Bild asynchron dekodieren (img.decode, gemeinsamer Dekodier-Thread)
const source = document.createElement('canvas');
source.width = source.height = 300;
source.getContext('2d').fillStyle = 'rgb(255, 0, 255)';
source.getContext('2d').fillRect(0, 0, 300, 300);
const decoded = new Image();
decoded.src = source.toDataURL('image/png');
decoded.decode().then(() => console.log('RESULT decode=' + decoded.naturalWidth), (e) => console.log('RESULT decode=fehler'));
// Ein wheel-Listener, der das Scrollen verhindert: der Scroll-Thread muss auf die Seite warten
document.getElementById('trap').addEventListener('wheel', (e) => { e.preventDefault(); console.log('RESULT trapwheel=1'); }, { passive: false });
console.log('RESULT ready=1');
</script>`;

const { url: siteURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));

const stack = await startStack({ token: 'compositing-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key) => results.wait(key);
const logs = results.logs;

await page.goto(stack.app({ url: siteURL, compositing: '1', debug: '1', env: process.env.COMP_ENV || '' }));
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
await screenshot(page, 'compositing-top');
const red = await pixelAt(50, 90), green = await pixelAt(130, 90), blue = await pixelAt(210, 90);
check('Farben stimmen (rot, gruen, blau)', near(red, [255, 0, 0]) && near(green, [0, 255, 0]) && near(blue, [0, 0, 255]), JSON.stringify({ red, green, blue }));
const bar = await pixelAt(500, 20);
check('Fixierte Leiste oben', near(bar, [255, 128, 0]), JSON.stringify(bar));
check('Compositing ist an', logs.some((line) => /Compositor: eigener Thread/.test(line)) && !logs.some((line) => /Compositing aus/.test(line)));

// Die Animation laeuft: der schwarze Kasten ist mal links, mal weiter rechts
// Linker Rand des schwarzen Kastens in der Zeile y=180 (auf 50 px gerundet),
// alle Punkte aus demselben Bild
const moverX = async () => {
  const row = await page.evaluate(() => window.blPageRow(180));
  const x = row ? row.findIndex((pixel) => near(pixel, [0, 0, 0], 60)) : -1;
  return x < 0 ? null : Math.round(x / 50) * 50;
};
const positions = new Set();
for (let i = 0; i < 20; i++) {
  const x = await moverX();
  if (x !== null)
    positions.add(x);
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

check('img.decode() (Bild im Hintergrund dekodiert)', await result('decode') === '300', results.get('decode'));

const framesBefore = Number(await result('frames'));
await page.waitForTimeout(2000);
results.delete('frames');
const framesAfter = Number(await result('frames'));
check('requestAnimationFrame laeuft weiter', framesAfter - framesBefore > 10, `${framesBefore} -> ${framesAfter}`);

// Die Animation laeuft im Compositor-Thread weiter, auch wenn das JS der Seite
// den Engine-Thread 3 s blockiert
await page.evaluate(() => window.__blEval('(() => { const end = Date.now() + 3000; while (Date.now() < end); return 1; })()'));
await page.waitForTimeout(400);
const busyPositions = new Set();
const busyStartAnim = Date.now();
while (Date.now() - busyStartAnim < 2000) {
  const x = await moverX();
  if (x !== null)
    busyPositions.add(x);
  await page.waitForTimeout(80);
}
check('Animation laeuft weiter, waehrend das JS blockiert', busyPositions.size >= 2, JSON.stringify([...busyPositions]));
if (busyPositions.size < 2)
  console.log(logs.filter((line) => /Compositor|Kachel|GPU/.test(line)).slice(-20).join('\n'));
await page.waitForTimeout(1500);

// Scrollen: Inhalt wandert, die Leiste bleibt
await page.mouse.move(500, 400);
await page.mouse.wheel(0, 900);
let scrolled = null;
await waitFor(async () => near(scrolled = await pixelAt(50, 130), [0, 128, 0]), 10000);
check('Scrollen verschiebt den Inhalt', near(scrolled, [0, 128, 0]), JSON.stringify(scrolled));
check('Leiste bleibt beim Scrollen', near(await pixelAt(500, 20), [255, 128, 0]));

// Scrollen im Scroll-Thread: geht auch, waehrend das JS der Seite den
// Engine-Thread 5 s blockiert
await page.evaluate(() => window.__blEval('(() => { const end = Date.now() + 5000; while (Date.now() < end); return 1; })()'));
await page.waitForTimeout(500);
const busyStart = Date.now();
await page.mouse.wheel(0, -900);
let busyScrolled = null;
const scrolledWhileBusy = await waitFor(async () => near(busyScrolled = await pixelAt(50, 90), [255, 0, 0]), 3000);
check('Scrollen, waehrend das JS blockiert', scrolledWhileBusy && Date.now() - busyStart < 4000, JSON.stringify(busyScrolled));
// Danach kennt auch die Seite die neue Position
await page.waitForTimeout(4000);
results.delete('scrollY');
await page.evaluate(() => window.__blEval('console.log("RESULT scrollY=" + scrollY)'));
check('Seite kennt die Scroll-Position', await result('scrollY') === '0');
await page.mouse.wheel(0, 900);
await waitFor(async () => near(await pixelAt(50, 130), [0, 128, 0]), 10000);

// wheel-Listener mit preventDefault: die Seite scrollt nicht
await page.mouse.move(100, 400);
await page.mouse.wheel(0, 300);
const trapped = await result('trapwheel');
await page.waitForTimeout(1000);
check('preventDefault im wheel-Listener verhindert Scrollen', trapped === '1' && near(await pixelAt(50, 130), [0, 128, 0]), JSON.stringify(await pixelAt(50, 130)));

// Kasten mit overflow: auto scrollt im Scroll-Thread, auch waehrend das JS blockiert
check('Scroll-Kasten oben violett', near(await pixelAt(500, 320), [255, 0, 255]), JSON.stringify(await pixelAt(500, 320)));
await page.evaluate(() => window.__blEval('(() => { const end = Date.now() + 4000; while (Date.now() < end); return 1; })()'));
await page.waitForTimeout(500);
await page.mouse.move(500, 400);
await page.mouse.wheel(0, 400);
let boxScrolled = null;
const boxOk = await waitFor(async () => near(boxScrolled = await pixelAt(500, 320), [0, 255, 255]), 2500);
check('Kasten scrollt, waehrend das JS blockiert', boxOk && near(await pixelAt(50, 130), [0, 128, 0]), JSON.stringify(boxScrolled));
await page.waitForTimeout(3500);

// GPU verloren: die Engine malt ohne Ebenen auf der CPU weiter
await page.evaluate(() => window.__blEngine()._bl_gpu_lose_context_for_testing());
await waitFor(async () => logs.some((line) => /Compositing aus/.test(line)), 15000);
await page.waitForTimeout(1000);
// Eine Aenderung nach dem Verlust muss ankommen (nicht nur das alte Bild)
await page.evaluate(() => window.__blEval('document.getElementById("late").style.background = "rgb(0, 0, 255)"'));
let afterLoss = null;
await waitFor(async () => near(afterLoss = await pixelAt(50, 130), [0, 0, 255]), 10000);
const barAfterLoss = await pixelAt(500, 20);
check('Nach GPU-Verlust weiter gemalt (ohne Ebenen)', near(afterLoss, [0, 0, 255]) && near(barAfterLoss, [255, 128, 0]), JSON.stringify({ afterLoss, barAfterLoss }));

await screenshot(page, 'compositing');
await browser.close();
finish();
