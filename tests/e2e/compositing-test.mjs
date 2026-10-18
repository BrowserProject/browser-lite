// End-to-End Test fuer Compositing mit Ebenen (?compositing=1): Farben der
// Kacheln, CSS-Animation (transform) ohne neues Malen, fixierte Leiste beim
// Scrollen, Blur-Filter und WebGL-Canvas in einer Ebene. Animation und Scrollen
// laufen weiter, waehrend das JS der Seite blockiert (Compositor-/Scroll-Thread).
// Nach einem GPU-Verlust ohne Ebenen, nach der Wiederherstellung neue Tabs mit.
// Ohne Compositor (?compositing=0) malt der Engine-Worker selber auf der GPU
// und nach Verlust und Wiederherstellung wieder dort. CSS-Filter: Wiederverwendung,
// Bildrate, Vergleich mit der CPU.
//
//   cd tests/e2e && node compositing-test.mjs [engine-ordner]
import { SWIFTSHADER, check, collect, finish, launch, near, pagePixel, screenshot, serve, startStack, timeLimit, waitFor } from './harness.mjs';

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

const GPU_PAGE = `<!doctype html><title>GPU-Test</title><body style="margin:0">
<div id="box" style="width:100px;height:100px;background:rgb(255,0,0)"></div>
<script>console.log('RESULT gpuready=1')</script>`;

const { url: siteURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(req.url === '/gpu' ? GPU_PAGE : PAGE));

const stack = await startStack({ token: 'compositing-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = collect(page);
const result = (key) => results.wait(key);
const logs = results.logs;

await page.goto(stack.app({ url: siteURL, compositing: '1', debug: '1', env: process.env.COMP_ENV || '' }));
check('Seite geladen', await result('ready') === '1');

const pixelAt = (x, y, target = page) => pagePixel(target, x, y);
// Warten, bis ein Bild mit Inhalt da ist (Kacheln werden im Hintergrund gemalt)
await waitFor(async () => near(await pixelAt(50, 90), [255, 0, 0]));
await screenshot(page, 'compositing-top');
const red = await pixelAt(50, 90), green = await pixelAt(130, 90), blue = await pixelAt(210, 90);
check('Farben stimmen (rot, gruen, blau)', near(red, [255, 0, 0]) && near(green, [0, 255, 0]) && near(blue, [0, 0, 255]), JSON.stringify({ red, green, blue }));
const bar = await pixelAt(500, 20);
check('Fixierte Leiste oben', near(bar, [255, 128, 0]), JSON.stringify(bar));
check('Compositing ist an', logs.some((line) => /Compositor: own thread/.test(line)) && !logs.some((line) => /compositing off/.test(line)));

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
async function positionsWhileBlocked() {
  await page.evaluate(() => window.__blEval('(() => { const end = Date.now() + 3000; while (Date.now() < end); return 1; })()'));
  await page.waitForTimeout(400);
  const positions = new Set();
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const x = await moverX();
    if (x !== null)
      positions.add(x);
    await page.waitForTimeout(80);
  }
  return positions;
}
const busyPositions = await positionsWhileBlocked();
check('Animation laeuft weiter, waehrend das JS blockiert', busyPositions.size >= 2, JSON.stringify([...busyPositions]));
if (busyPositions.size < 2)
  console.log(logs.filter((line) => /Compositor|tile|GPU/.test(line)).slice(-20).join('\n'));
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
await waitFor(async () => logs.some((line) => /compositing off/.test(line)), 15000);
await page.waitForTimeout(1000);
// Eine Aenderung nach dem Verlust muss ankommen (nicht nur das alte Bild)
await page.evaluate(() => window.__blEval('document.getElementById("late").style.background = "rgb(0, 0, 255)"'));
let afterLoss = null;
await waitFor(async () => near(afterLoss = await pixelAt(50, 130), [0, 0, 255]), 10000);
const barAfterLoss = await pixelAt(500, 20);
check('Nach GPU-Verlust weiter gemalt (ohne Ebenen)', near(afterLoss, [0, 0, 255]) && near(barAfterLoss, [255, 128, 0]), JSON.stringify({ afterLoss, barAfterLoss }));

// Der Browser stellt den Kontext wieder her: ein neuer Tab bekommt wieder Ebenen
await page.evaluate(() => window.__blEngine()._bl_gpu_restore_context_for_testing());
check('GPU wiederhergestellt', await waitFor(async () => logs.some((line) => /GPU: WebGL context is back/.test(line)), 10000));
const stopsBefore = logs.filter((line) => /compositing off/.test(line)).length;
results.delete('ready');
await page.click('#new-tab');
await page.fill('#address', siteURL);
await page.press('#address', 'Enter');
check('Neuer Tab nach der Wiederherstellung', await result('ready') === '1');
await waitFor(async () => near(await pixelAt(50, 90), [255, 0, 0]));
const restoredPositions = await positionsWhileBlocked();
check('Neuer Tab mit Ebenen: Animation laeuft, waehrend das JS blockiert', restoredPositions.size >= 2
  && logs.filter((line) => /compositing off/.test(line)).length === stopsBefore, JSON.stringify([...restoredPositions]));

await screenshot(page, 'compositing');
await page.close();

// Ohne Compositor: GPU verloren, dann wiederhergestellt. Danach malt der View
// wieder auf der GPU (nicht nur irgendwie), ohne auf die CPU zurueckzufallen.
const gpuPage = await browser.newPage({ viewport: { width: 600, height: 400 } });
const gpuResults = collect(gpuPage);
const gpuLogs = gpuResults.logs;
const gpuLog = (pattern) => gpuLogs.some((line) => pattern.test(line));
await gpuPage.goto(stack.app({ url: siteURL + 'gpu', compositing: '0', debug: '1' }));
check('Ohne Compositor geladen', await gpuResults.wait('gpuready') === '1');
const boxColor = (rgb) => gpuPage.evaluate((rgb) => window.__blEval(`document.getElementById("box").style.background = "rgb(${rgb})"`), rgb.join(', '));
// Pixel des Kastens, sobald er die Farbe hat (sonst nach 10 s der letzte)
const boxPixel = async (rgb) => {
  let pixel = null;
  await waitFor(async () => near(pixel = await pixelAt(50, 50, gpuPage), rgb), 10000);
  return pixel;
};
let box = await boxPixel([255, 0, 0]);
check('Ohne Compositor: Engine-Worker malt auf der GPU', near(box, [255, 0, 0])
  && gpuLog(/GPU: Skia paints through WebGL 2/) && !gpuLog(/Compositor: own thread/), JSON.stringify(box));
await gpuPage.evaluate(() => window.__blEngine()._bl_gpu_lose_context_for_testing());
await waitFor(async () => gpuLog(/GPU: WebGL-Kontext verloren/), 10000);
await boxColor([0, 0, 255]);
box = await boxPixel([0, 0, 255]);
check('Ohne Compositor: nach GPU-Verlust auf der CPU gemalt', near(box, [0, 0, 255]), JSON.stringify(box));
await gpuPage.evaluate(() => window.__blEngine()._bl_gpu_restore_context_for_testing());
const viewsBack = await waitFor(async () => gpuLog(/GPU: views back on the GPU: 1/), 10000);
await boxColor([0, 160, 0]);
box = await boxPixel([0, 160, 0]);
check('Ohne Compositor: nach der Wiederherstellung wieder auf der GPU gemalt', viewsBack && near(box, [0, 160, 0])
  && !gpuLog(/Bild nicht auf die GPU gebracht/), JSON.stringify(box));
// Verlust und Wiederherstellung direkt nacheinander, vor dem naechsten Bild:
// keine Flaeche des alten Kontexts darf uebrig bleiben
const restores = () => gpuLogs.filter((line) => /GPU: views back on the GPU: 1/.test(line)).length;
await gpuPage.evaluate(() => {
  window.__blEngine()._bl_gpu_lose_context_for_testing();
  window.__blEngine()._bl_gpu_restore_context_for_testing();
});
const backAgain = await waitFor(async () => restores() === 2, 10000);
await boxColor([255, 0, 255]);
box = await boxPixel([255, 0, 255]);
check('Ohne Compositor: Verlust und Wiederherstellung direkt nacheinander', backAgain && near(box, [255, 0, 255])
  && !gpuLog(/Bild nicht auf die GPU gebracht/), JSON.stringify(box));
await gpuPage.close();

// CSS-Filter auf der GPU: Blur und Schatten rechnet der Compositor. Ein Layer ohne
// Aenderung behaelt sein gefiltertes Bild (Patch 0036), ein verschobener filtert in
// seiner Ebene und kommt nach dem Stillstand wieder auf die Geraetepixel.
// Varianten: still (keine Bewegung), nofilter (ohne Filter, Vergleich der Bildrate)
function filterPage(params) {
  const still = params.has('still'), nofilter = params.has('nofilter');
  const filter = (value) => nofilter ? 'none' : value;
  const cards = [];
  for (let i = 0; i < 12; i++) {
    const left = 20 + (i % 6) * 160, top = 20 + Math.floor(i / 6) * 150;
    cards.push(`<div class="card" style="left:${left}px;top:${top}px;filter:${filter(i % 2 ? 'drop-shadow(6px 6px 4px rgb(0,0,0))' : 'blur(4px)')}">Karte ${i}</div>`);
  }
  return `<!doctype html><title>Filter-Test</title><style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  .card { position: absolute; width: 120px; height: 100px; background: linear-gradient(135deg, rgb(255, 160, 0), rgb(0, 120, 255)); color: #fff; }
  #mover { top: 340px; left: 20px; filter: ${filter('blur(3px)')}; ${still ? '' : 'animation: slide 1s linear infinite alternate;'} }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(300px); } }
  #change { position: absolute; top: 340px; left: 700px; width: 100px; height: 100px; background: rgb(255, 0, 0); filter: ${filter('blur(6px)')}; }
  #settle { top: 500px; left: ${still ? 60 : 20}px; filter: ${filter('drop-shadow(6px 6px 4px rgb(0,0,0))')}; transition: transform 0.3s linear; }
</style>${cards.join('')}
<div class="card" id="mover">Bewegt</div><div id="change"></div><div class="card" id="settle">Steht</div>
<script>
${still ? '' : "requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById('settle').style.transform = 'translateX(40px)'; }));"}
console.log('RESULT filterready=1');
</script>`;
}
const { url: filterURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  .end(filterPage(new URL(req.url, 'http://localhost').searchParams)));

// Zeilen mit den stehenden Karten und dem Kasten, der nach der Bewegung steht
const FILTER_ROWS = [40, 70, 100, 125, 190, 220, 250, 275, 520, 550, 580, 605];
async function openFilterPage(query, compositing) {
  const filterTab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const filterResults = collect(filterTab);
  await filterTab.goto(stack.app({ url: filterURL + query, compositing, debug: '1' }));
  check(`Filter-Seite ${query} (compositing=${compositing}) geladen`, await filterResults.wait('filterready') === '1');
  // Kacheln gemalt, Uebergang fertig, verschobene Layer wieder auf den Geraetepixeln
  await waitFor(async () => (await pixelAt(80, 70, filterTab) || [255]).some((value) => value < 200));
  await filterTab.waitForTimeout(2500);
  return filterTab;
}
const filterRows = (target) => target.evaluate((ys) => ys.map((y) => window.blPageRow(y)), FILTER_ROWS);
const rowDiff = (a, b) => {
  let max = 0, sum = 0, count = 0;
  a.forEach((row, i) => row.forEach((pixel, x) => pixel.forEach((value, c) => {
    const diff = Math.abs(value - b[i][x][c]);
    max = Math.max(max, diff);
    sum += diff;
    count++;
  })));
  return { max, mean: +(sum / count).toFixed(2) };
};
// Bilder des Compositors pro Sekunde (rAF in seinem Worker, aus dem Chrome-Trace)
async function compositorFps(target) {
  await browser.startTracing(target, { categories: ['devtools.timeline'] });
  await target.waitForTimeout(3000);
  const trace = JSON.parse((await browser.stopTracing()).toString());
  const frames = new Map();
  for (const event of trace.traceEvents) {
    if (event.name === 'FireAnimationFrame' && event.ph === 'X')
      frames.set(event.tid, (frames.get(event.tid) || 0) + 1);
  }
  return Math.max(0, ...frames.values()) / 3;
}

const animated = await openFilterPage('', '1');
const animatedRows = await filterRows(animated);
await animated.evaluate(() => window.__blEval('document.getElementById("change").style.background = "rgb(0, 0, 255)"'));
let changed = null;
await waitFor(async () => near(changed = await pixelAt(750, 390, animated), [0, 0, 255]), 10000);
check('Gefilterter Layer zeigt neuen Inhalt', near(changed, [0, 0, 255]), JSON.stringify(changed));
const filterFps = await compositorFps(animated);
await animated.close();

const plain = await openFilterPage('?nofilter', '1');
const plainFps = await compositorFps(plain);
await plain.close();
check('Bildrate mit Blur und Schatten fast wie ohne Filter', plainFps > 10 && filterFps >= 0.5 * plainFps, `${filterFps.toFixed(1)} vs ${plainFps.toFixed(1)} Bilder/s`);

const still = await openFilterPage('?still', '1');
const stillRows = await filterRows(still);
await still.close();
const reuse = rowDiff(animatedRows, stillRows);
check('Wiederverwendete und wieder ausgerichtete Filter wie ohne Bewegung', reuse.max <= 2, JSON.stringify(reuse));

const cpu = await openFilterPage('?still', '0');
const cpuRows = await filterRows(cpu);
await cpu.close();
const gpuVsCpu = rowDiff(stillRows, cpuRows);
check('Filter auf der GPU wie auf der CPU (ohne Compositor)', gpuVsCpu.max <= 16 && gpuVsCpu.mean <= 1, JSON.stringify(gpuVsCpu));
await browser.close();
finish();
