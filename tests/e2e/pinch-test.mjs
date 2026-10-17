// End-to-End Test fuer Pinch-Zoom wie Chrome (engine/src/PinchZoom.h): Touchpad
// (Strg + Rad, per CDP Input.synthesizePinchGesture) und zwei Finger skalieren
// nur die Ansicht. Der Compositor-Thread zeigt die Geste sofort, auch wenn das
// JS der Seite den Engine-Thread blockiert; danach kennt die Seite die neue
// Skalierung (visualViewport mit resize-Event), das Layout bleibt gleich breit.
// Klick und Rad gleich nach der Geste gehen nicht verloren und treffen, was zu
// sehen ist. touch-action: none und preventDefault der Seite verhindern das
// Zoomen, Strg + Mausrad bleibt Seiten-Zoom. Strg + Rad geht zuerst an die
// Seite: ruft ein wheel-Listener preventDefault (wie Karten), zoomt nur sie,
// auch in einem iframe (eingebettete Karte), ohne blockierenden Listener an
// der Stelle zoomt die Ansicht sofort,
// eine neue Seite beginnt bei 1 (Zurueck stellt wieder her). Ohne Compositor
// (?compositing=0) skaliert der Engine-Thread.
//
//   cd tests/e2e && node pinch-test.mjs [engine-ordner]
import { SWIFTSHADER, canvasOrigin, check, collect, finish, launch, near, pagePixel, screenshot, serve, startStack, timeLimit, waitFor } from './harness.mjs';

timeLimit();

// Rotes Feld 100..200, gruenes 250..300 (oben links), blaues Feld mit
// touch-action: none, graues mit touchmove-Listener, der zwei Finger selber
// will, und wheel-Listener ohne preventDefault. Die "Karte" (orange) zoomt
// mit Strg + Rad selber, ebenso die eingebettete Karte im iframe (gelb, Listener
// auf ihrem Dokument), das Dokument liest Strg + Rad passiv mit. Die Leiste
// #wide ist so breit wie das Layout.
const PAGE = `<!doctype html><title>Pinch-Test</title>
<style>
  body { margin: 0; background: #fff; height: 2000px; }
  #wide { height: 20px; background: rgb(200, 200, 200); }
  .box { position: absolute; }
</style>
<div id="wide"></div>
<div id="red" class="box" style="left:100px;top:100px;width:100px;height:100px;background:rgb(255,0,0)"></div>
<div class="box" style="left:250px;top:100px;width:50px;height:50px;background:rgb(0,160,0)"></div>
<div class="box" style="left:100px;top:400px;width:100px;height:100px;background:rgb(255,0,255)"></div>
<div id="nozoom" class="box" style="left:500px;top:300px;width:400px;height:300px;background:rgb(0,0,255);touch-action:none"></div>
<div id="grab" class="box" style="left:500px;top:50px;width:400px;height:200px;background:rgb(120,120,120)"></div>
<div id="map" class="box" style="left:250px;top:550px;width:150px;height:100px;background:rgb(255,160,0)"></div>
<iframe src="/frame" class="box" style="left:50px;top:550px;width:150px;height:100px;border:0"></iframe>
<script>
let resizes = 0;
visualViewport.addEventListener('resize', () => console.log('RESULT vvresize=' + ++resizes));
document.getElementById('red').addEventListener('click', (e) => console.log('RESULT redclick=' + Math.round(e.pageX) + ',' + Math.round(e.pageY)));
document.getElementById('grab').addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    console.log('RESULT grabbed=1');
  }
}, { passive: false });
let grabWheels = 0;
document.getElementById('grab').addEventListener('wheel', (e) => {
  if (e.ctrlKey && !grabWheels++)
    console.log('RESULT grabcancelable=' + e.cancelable);
  else if (e.ctrlKey && !e.cancelable)
    console.log('RESULT grabpassive=1');
}, { passive: false });
let mapZooms = 0;
document.getElementById('map').addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    console.log('RESULT mapzoom=' + ++mapZooms);
  }
}, { passive: false });
let ctrlWheels = 0;
document.addEventListener('wheel', (e) => e.ctrlKey && console.log('RESULT ctrlwheel=' + ++ctrlWheels), { passive: true });
console.log('RESULT ready=1');
</script>`;

const FRAME = `<!doctype html><style>body { margin: 0; background: rgb(255, 220, 0); }</style>
<script>
let frameZooms = 0;
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    console.log('RESULT framezoom=' + ++frameZooms);
  }
}, { passive: false });
</script>`;

const { url: siteURL } = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(req.url === '/frame' ? FRAME : PAGE));
const stack = await startStack({ token: 'pinch-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true });
const page = await context.newPage();
const results = collect(page);
const result = (key, ms) => results.wait(key, ms);
const cdp = await context.newCDPSession(page);

await page.goto(stack.app({ url: siteURL, debug: '1' }));
check('Seite geladen', await result('ready') === '1');

const pixelAt = (x, y) => pagePixel(page, x, y);
// Die Geste endet nicht genau bei 2 (Schritte multiplizieren sich), darum +-1 px
const clickAt190 = (text) => text && text.split(',').every((v) => Math.abs(Number(v) - 190) <= 1);
const RED = [255, 0, 0], GREEN = [0, 160, 0], WHITE = [255, 255, 255], MAGENTA = [255, 0, 255];
// Wert aus der Seite (JSON), ueber die Konsole
let asked = 0;
async function pageValue(expression) {
  const key = 'value' + ++asked;
  await page.evaluate(([key, expression]) => window.__blEval(`console.log("RESULT ${key}=" + JSON.stringify(${expression}))`), [key, expression]);
  const value = await result(key, 10000);
  return value === null ? null : JSON.parse(value);
}
const viewport = () => pageValue('{ scale: visualViewport.scale, width: visualViewport.width, left: visualViewport.pageLeft, top: visualViewport.pageTop, layout: document.documentElement.clientWidth, wide: document.getElementById("wide").getBoundingClientRect().width }');
const blockEngine = (ms) => page.evaluate((ms) => window.__blEval(`(() => { const end = Date.now() + ${ms}; while (Date.now() < end); return 1; })()`), ms);
const origin = await canvasOrigin(page);
const at = (x, y) => ({ x: origin.x + x, y: origin.y + y });
// Rot und Gruen doppelt so gross, Mittelpunkt (100, 100) bleibt stehen
const scaledTwice = async () => near(await pixelAt(150, 150), RED) && near(await pixelAt(250, 250), RED)
  && near(await pixelAt(275, 125), RED) && near(await pixelAt(450, 150), GREEN);
// Magenta (100..200, 400..500) doppelt so gross bei pageLeft 50, pageTop 350
const magentaTwice = async () => near(await pixelAt(150, 150), MAGENTA) && near(await pixelAt(280, 280), MAGENTA) && near(await pixelAt(320, 150), WHITE);
const unscaled = async () => near(await pixelAt(150, 150), RED) && near(await pixelAt(275, 125), GREEN) && near(await pixelAt(450, 150), WHITE);

await waitFor(unscaled, 20000);
const before = await viewport();
check('Vorher ohne Pinch-Zoom', before?.scale === 1 && await unscaled(), JSON.stringify(before));

// 1) Touchpad-Pinch (Strg + Rad), waehrend das JS der Seite den Engine-Thread
// blockiert: der Compositor-Thread zeigt die Geste trotzdem gleich
await blockEngine(5000);
await page.waitForTimeout(300);
const pinchStart = Date.now();
await cdp.send('Input.synthesizePinchGesture', { ...at(100, 100), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
const shownWhileBlocked = await waitFor(scaledTwice, 2500);
check('Touchpad-Pinch zeigt sofort, waehrend das JS blockiert', shownWhileBlocked && Date.now() - pinchStart < 4500,
  JSON.stringify({ ms: Date.now() - pinchStart, red: await pixelAt(250, 250), green: await pixelAt(450, 150) }));
await screenshot(page, 'pinch-blocked');
// Der passive wheel-Listener des Dokuments hat nicht blockiert und liest mit
check('Die Seite liest den Touchpad-Pinch passiv mit', await result('ctrlwheel', 15000) !== null);

// 2) Danach kennt die Seite die Skalierung, das Layout ist gleich breit
check('Seite bekommt visualViewport resize', await result('vvresize', 15000) !== null);
const after = await viewport();
check('visualViewport.scale ist 2', Math.abs(after?.scale - 2) < 0.05, JSON.stringify(after));
check('Layout gleich breit', after?.layout === before.layout && Math.abs(after?.wide - before.wide) < 0.5, JSON.stringify({ before, after }));
check('visualViewport halb so breit, Mittelpunkt bleibt', Math.abs(after?.width - before.width / 2) < 2
  && Math.abs(after?.left - 50) < 2 && Math.abs(after?.top - 50) < 2, JSON.stringify(after));
await page.waitForTimeout(500);
check('Nach der Uebernahme scharf neu gemalt, gleiche Stelle', await waitFor(scaledTwice, 5000),
  JSON.stringify({ red: await pixelAt(250, 250), green: await pixelAt(450, 150) }));
// Klicks treffen, was zu sehen ist: (280, 280) liegt jetzt im roten Feld
await page.mouse.click(at(280, 280).x, at(280, 280).y);
check('Klick trifft das vergroesserte Feld', clickAt190(await result('redclick', 10000)), results.get('redclick'));

// 3) Wieder hinaus: nicht kleiner als 1
await cdp.send('Input.synthesizePinchGesture', { ...at(300, 300), scaleFactor: 0.25, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await waitFor(async () => (await viewport())?.scale === 1, 10000);
const back = await viewport();
check('Hinaus bis Skalierung 1', back?.scale === 1 && back.left === 0 && back.top === 0 && await waitFor(unscaled, 5000), JSON.stringify(back));

const zoomOutToTop = async () => {
  await cdp.send('Input.synthesizePinchGesture', { ...at(300, 300), scaleFactor: 0.25, relativeSpeed: 1600, gestureSourceType: 'mouse' });
  await waitFor(async () => (await viewport())?.scale === 1, 10000);
  await page.mouse.wheel(0, -3000);
  await waitFor(async () => (await viewport())?.top === 0 && await unscaled(), 10000);
};
const zoomedAt = (top) => async () => {
  const value = await viewport();
  return Math.abs(value?.scale - 2) < 0.05 && Math.abs(value.left - 50) < 2 && Math.abs(value.top - top) < 2;
};

// 3a) Klick gleich nach der Geste, bevor die Oberflaeche sie per Zeitablauf
// beendet: er beendet sie, die Engine uebernimmt das Ziel vor dem Klick
results.delete('redclick');
await cdp.send('Input.synthesizePinchGesture', { ...at(100, 100), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await page.mouse.click(at(280, 280).x, at(280, 280).y);
check('Klick gleich nach dem Pinch trifft das vergroesserte Feld', clickAt190(await result('redclick', 10000)), results.get('redclick'));
await zoomOutToTop();

// 3b) Gleich nach der Geste weiterscrollen: das Rad verschiebt die skalierte
// Ansicht, auch bevor der Engine-Thread sie uebernommen hat, nichts geht verloren
await page.mouse.move(at(500, 400).x, at(500, 400).y);
await cdp.send('Input.synthesizePinchGesture', { ...at(100, 100), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await page.mouse.wheel(0, 300);
await waitFor(zoomedAt(200), 10000);
await page.mouse.wheel(0, 300);
check('Rad gleich nach dem Pinch geht nicht verloren', await waitFor(zoomedAt(350), 10000) && await waitFor(magentaTwice, 5000),
  JSON.stringify(await viewport()));
await zoomOutToTop();

// 3c) Dasselbe, waehrend das JS blockiert: Zoomen und Scrollen sofort, die
// Uebernahme danach behaelt die gescrollte Stelle
await blockEngine(5000);
await page.waitForTimeout(300);
const pannedStart = Date.now();
await cdp.send('Input.synthesizePinchGesture', { ...at(100, 100), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await page.mouse.wheel(0, 300);
await page.waitForTimeout(100);
await page.mouse.wheel(0, 300);
const pannedWhileBlocked = await waitFor(magentaTwice, 2000);
check('Pinch und Rad, waehrend das JS blockiert', pannedWhileBlocked && Date.now() - pannedStart < 4500,
  JSON.stringify({ ms: Date.now() - pannedStart, inside: await pixelAt(280, 280), outside: await pixelAt(320, 150) }));
check('Danach: Skalierung 2, das Rad ist mit uebernommen', await waitFor(zoomedAt(350), 15000) && await waitFor(magentaTwice, 5000),
  JSON.stringify(await viewport()));
await zoomOutToTop();

// 3d) Erst im Scroll-Thread scrollen, dann zoomen, beides waehrend das JS
// blockiert: der Compositor nimmt die gezeigte Scroll-Position
await blockEngine(6000);
await page.waitForTimeout(300);
await page.mouse.move(at(500, 400).x, at(500, 400).y);
await page.mouse.wheel(0, 300);
const scrolledWhileBlocked = await waitFor(async () => near(await pixelAt(150, 150), MAGENTA), 2000);
await cdp.send('Input.synthesizePinchGesture', { ...at(100, 100), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
check('Scrollen und Pinch, waehrend das JS blockiert', scrolledWhileBlocked && await waitFor(magentaTwice, 2000),
  JSON.stringify({ inside: await pixelAt(280, 280), outside: await pixelAt(320, 150) }));
await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 15000);
const scrolledZoom = await viewport();
check('Danach: Skalierung 2 an der gescrollten Stelle', Math.abs(scrolledZoom?.scale - 2) < 0.05 && Math.abs(scrolledZoom.left - 50) < 2
  && Math.abs(scrolledZoom.top - 350) < 2 && await waitFor(magentaTwice, 5000), JSON.stringify(scrolledZoom));
await zoomOutToTop();

// 4) Strg + Mausrad bleibt Seiten-Zoom (Stufe 110 %), ohne Pinch
const ctrlWheelAt = (point, target = page) => target.evaluate(({ x, y }) => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}, point);
const zoomText = (target = page) => target.evaluate(() => document.getElementById('zoom').textContent);
await ctrlWheelAt(at(300, 300));
const zoomLabel = await zoomText();
check('Strg + Mausrad: Seiten-Zoom', zoomLabel === '110 %' && (await viewport())?.scale === 1, zoomLabel);
await page.click('#zoom');
await waitFor(async () => (await viewport())?.layout === before.layout, 10000);

// 4b) Strg + Rad geht zuerst an die Seite: die "Karte" ruft preventDefault,
// dann zoomt weder die Ansicht (Touchpad) noch die Seite (Mausrad)
await cdp.send('Input.synthesizePinchGesture', { ...at(325, 600), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await result('mapzoom', 10000);
await page.waitForTimeout(1000);
// Jedes Ereignis der Geste geht cancelable an die Seite
check('Touchpad-Pinch auf der Karte: die Seite zoomt selber, die Ansicht nicht', Number(results.get('mapzoom')) > 1
  && (await viewport())?.scale === 1 && await unscaled(),
  JSON.stringify({ mapzoom: results.get('mapzoom'), viewport: await viewport() }));
const zoomsBefore = Number(results.get('mapzoom'));
await ctrlWheelAt(at(325, 600));
await waitFor(() => Number(results.get('mapzoom')) > zoomsBefore, 10000);
await page.waitForTimeout(500);
check('Strg + Mausrad auf der Karte: kein Seiten-Zoom', Number(results.get('mapzoom')) === zoomsBefore + 1 && await zoomText() === '100 %',
  await zoomText());

// 4b') Dasselbe mit der Karte im iframe: das preventDefault ihres Dokuments zaehlt
await cdp.send('Input.synthesizePinchGesture', { ...at(125, 600), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await result('framezoom', 10000);
await page.waitForTimeout(1000);
check('Touchpad-Pinch auf der Karte im iframe: nur sie zoomt', Number(results.get('framezoom')) > 1
  && (await viewport())?.scale === 1 && await unscaled(),
  JSON.stringify({ framezoom: results.get('framezoom'), viewport: await viewport() }));
const frameZoomsBefore = Number(results.get('framezoom'));
await ctrlWheelAt(at(125, 600));
await waitFor(() => Number(results.get('framezoom')) > frameZoomsBefore, 10000);
await page.waitForTimeout(500);
check('Strg + Mausrad auf der Karte im iframe: kein Seiten-Zoom', Number(results.get('framezoom')) === frameZoomsBefore + 1
  && await zoomText() === '100 %', JSON.stringify({ framezoom: results.get('framezoom'), zoom: await zoomText() }));

// 4c) Ein wheel-Listener ohne preventDefault: das erste Ereignis ist
// cancelable, nach der Antwort zoomt die Ansicht, die Seite liest den Rest mit
await cdp.send('Input.synthesizePinchGesture', { ...at(700, 150), scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
const grabZoomed = await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 10000);
check('Listener ohne preventDefault: Touchpad-Pinch zoomt die Ansicht', grabZoomed && results.get('grabcancelable') === 'true'
  && results.get('grabpassive') === '1', JSON.stringify({ cancelable: results.get('grabcancelable'), passive: results.get('grabpassive'), viewport: await viewport() }));
await zoomOutToTop();

// 5) Zwei Finger: auf einem Feld mit touch-action: none zoomt nichts
const touchPinch = async (cx, cy, from, to) => {
  const points = (d) => [{ ...at(cx - d / 2, cy), id: 1 }, { ...at(cx + d / 2, cy), id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  // Antwort der Seite auf touchstart abwarten (preventDefault, touch-action)
  await page.waitForTimeout(300);
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * i / 10) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
results.delete('vvresize');
await touchPinch(700, 450, 100, 200);
await page.waitForTimeout(1500);
check('touch-action: none verhindert Pinch-Zoom', (await viewport())?.scale === 1 && await unscaled());

// 5b) Will die Seite die zwei Finger selber (preventDefault bei touchmove),
// bricht die schon angefangene Geste ab und die Ansicht geht zurueck
await touchPinch(700, 150, 100, 200);
await page.waitForTimeout(1500);
check('preventDefault der Seite bricht Pinch-Zoom ab', await result('grabbed', 5000) === '1'
  && (await viewport())?.scale === 1 && await unscaled(), JSON.stringify(await viewport()));

// 6) Zwei Finger um (100, 100) auseinander: doppelt so gross
await touchPinch(100, 100, 100, 200);
check('Zwei Finger: Seite bekommt visualViewport resize', await result('vvresize', 15000) !== null);
const touched = await viewport();
check('Zwei Finger: visualViewport.scale ist 2, Layout gleich', Math.abs(touched?.scale - 2) < 0.05
  && touched.layout === before.layout && Math.abs(touched.wide - before.wide) < 0.5, JSON.stringify(touched));
check('Zwei Finger: Inhalt doppelt so gross', await waitFor(scaledTwice, 5000),
  JSON.stringify({ red: await pixelAt(250, 250), green: await pixelAt(450, 150) }));

// Eine neue Seite beginnt ohne Pinch-Zoom, Zurueck bringt ihn wieder
results.delete('ready');
await page.fill('#address', siteURL + '?neu');
await page.press('#address', 'Enter');
await result('ready', 20000);
const fresh = await viewport();
results.delete('ready');
await page.click('#back');
await result('ready', 20000);
await waitFor(async () => Math.abs((await viewport())?.scale - 2) < 0.05, 10000);
const restored = await viewport();
check('Neue Seite ohne Pinch-Zoom, Zurueck stellt ihn wieder her', fresh?.scale === 1 && Math.abs(restored?.scale - 2) < 0.05,
  JSON.stringify({ fresh, restored }));

await screenshot(page, 'pinch');
await page.close();

// 7) Ohne Compositor (?compositing=0) skaliert der Engine-Thread selber
const plain = await context.newPage();
const plainResults = collect(plain);
await plain.goto(stack.app({ url: siteURL, compositing: '0' }));
check('Ohne Compositor geladen', await plainResults.wait('ready') === '1');
const plainPixel = (x, y) => pagePixel(plain, x, y);
await waitFor(async () => near(await plainPixel(150, 150), RED), 20000);
const plainCDP = await context.newCDPSession(plain);
const plainOrigin = await canvasOrigin(plain);
// Auch hier geht Strg + Rad zuerst an die Seite: die Karte zoomt selber
const plainResizes = plainResults.get('vvresize');
await plainCDP.send('Input.synthesizePinchGesture', { x: plainOrigin.x + 325, y: plainOrigin.y + 600, scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
const plainMap = await plainResults.wait('mapzoom', 10000);
await plain.waitForTimeout(1000);
check('Ohne Compositor: die Karte zoomt selber, die Ansicht nicht', plainMap !== null && plainResults.get('vvresize') === plainResizes
  && near(await plainPixel(250, 250), WHITE) && near(await plainPixel(150, 150), RED),
  JSON.stringify({ mapzoom: plainMap, resizes: [plainResizes, plainResults.get('vvresize')], red: await plainPixel(150, 150), white: await plainPixel(250, 250) }));
await plainCDP.send('Input.synthesizePinchGesture', { x: plainOrigin.x + 125, y: plainOrigin.y + 600, scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
await plainResults.wait('framezoom', 10000);
await plain.waitForTimeout(1000);
const plainFrameZooms = Number(plainResults.get('framezoom'));
await ctrlWheelAt({ x: plainOrigin.x + 125, y: plainOrigin.y + 600 }, plain);
await waitFor(() => Number(plainResults.get('framezoom')) > plainFrameZooms, 10000);
await plain.waitForTimeout(500);
check('Ohne Compositor: die Karte im iframe zoomt selber, weder Ansicht noch Seite', plainFrameZooms > 1
  && Number(plainResults.get('framezoom')) === plainFrameZooms + 1 && plainResults.get('vvresize') === plainResizes
  && near(await plainPixel(250, 250), WHITE) && await zoomText(plain) === '100 %',
  JSON.stringify({ framezoom: plainResults.get('framezoom'), resizes: [plainResizes, plainResults.get('vvresize')], zoom: await zoomText(plain) }));
plainResults.delete('vvresize');
await plainCDP.send('Input.synthesizePinchGesture', { x: plainOrigin.x + 100, y: plainOrigin.y + 100, scaleFactor: 2, relativeSpeed: 1600, gestureSourceType: 'mouse' });
const plainScaled = await waitFor(async () => near(await plainPixel(250, 250), RED) && near(await plainPixel(450, 150), GREEN), 10000);
check('Ohne Compositor: Pinch-Zoom', plainScaled && await plainResults.wait('vvresize', 10000) !== null,
  JSON.stringify({ red: await plainPixel(250, 250), green: await plainPixel(450, 150) }));
await browser.close();
finish();
