// End-to-End Test fuer CSS Paint Worklets (CSS.paintWorklet, paint() in CSS,
// Patch 0034): Skript ueber URL und als Blob laden, Farben aus inputProperties
// und inputArguments, neu malen nach Aenderung einer Eigenschaft, Element in
// eigener Ebene, Fehler beim Laden (404, falscher Typ, Syntaxfehler), jede URL
// nur einmal geladen, schon registrierter Name in weiteren Modulen ohne Speicherleck,
// CSP auch nach Umleitung. Mit und ohne Compositing.
//
//   cd tests/e2e && node paintworklet-test.mjs [engine-ordner]
import { SWIFTSHADER, check, collect, finish, launch, near, pagePixel, screenshot, serve, startStack, timeLimit, waitFor } from './harness.mjs';

timeLimit();

// Oben die Farbe aus --farbe, unten blau. Meldet die Groesse beim ersten Malen.
const WORKLET = `registerPaint('karo', class {
  static get inputProperties() { return ['--farbe']; }
  paint(ctx, size, props) {
    ctx.fillStyle = String(props.get('--farbe')).trim();
    ctx.fillRect(0, 0, size.width, size.height / 2);
    ctx.fillStyle = 'rgb(0, 0, 255)';
    ctx.fillRect(0, size.height / 2, size.width, size.height / 2);
  }
});`;

// Registriert karo noch einmal (die erste Registrierung bleibt)
const AGAIN_WORKLET = `registerPaint('karo', class {
  paint(ctx, size) { ctx.fillStyle = 'rgb(0, 0, 0)'; ctx.fillRect(0, 0, size.width, size.height); }
});`;

// Farbe als Argument von paint(streifen, <farbe>)
const BLOB_WORKLET = `registerPaint('streifen', class {
  static get inputArguments() { return ['<color>']; }
  paint(ctx, size, props, args) {
    ctx.fillStyle = String(args[0]).trim();
    ctx.fillRect(0, 0, size.width, size.height);
  }
});`;

const PAGE = `<!doctype html><title>Paint-Worklet-Test</title>
<style>
  body { margin: 0; background: #fff; }
  .box { position: absolute; top: 20px; width: 100px; height: 100px; }
  #karo { left: 20px; background-image: paint(karo); --farbe: rgb(0, 200, 0); }
  #ebene { left: 160px; background-image: paint(karo); --farbe: rgb(255, 160, 0); will-change: transform; }
  #streifen { left: 300px; background-image: paint(streifen, rgb(255, 0, 255)); }
</style>
<div class="box" id="karo"></div>
<div class="box" id="ebene"></div>
<div class="box" id="streifen"></div>
<script>
  const result = (key, value) => console.log('RESULT ' + key + '=' + value);
  const failure = (key) => (e) => result(key, e && e.name);
  result('api', typeof CSS.paintWorklet === 'object' && typeof CSS.paintWorklet.addModule === 'function' ? 1 : 0);
  // Gleiche URL dreimal: zwei gleichzeitig, eine nach dem Laden
  Promise.all([CSS.paintWorklet.addModule('karo.js'), CSS.paintWorklet.addModule('karo.js')])
    .then(() => CSS.paintWorklet.addModule('karo.js')).then(() => result('url', 1), failure('url'));
  const blob = new Blob([${JSON.stringify(BLOB_WORKLET)}], { type: 'text/javascript' });
  CSS.paintWorklet.addModule(URL.createObjectURL(blob)).then(() => result('blob', 1), failure('blob'));
  CSS.paintWorklet.addModule('fehlt.js').then(() => result('missing', 'ok'), failure('missing'));
  CSS.paintWorklet.addModule('text.txt').then(() => result('mime', 'ok'), failure('mime'));
  CSS.paintWorklet.addModule('kaputt.js').then(() => result('syntax', 'ok'), failure('syntax'));
  CSS.paintWorklet.addModule(FREMD).then(() => result('csp', 'ok'), failure('csp'));
  CSS.paintWorklet.addModule('umleitung.js').then(() => result('cspredirect', 'ok'), failure('cspredirect'));
  window.nochmal = async (count) => {
    try {
      for (let i = 0; i < count; i++)
        await CSS.paintWorklet.addModule('nochmal.js?' + i);
      result('again', 1);
    } catch (e) { result('again', e && e.name); }
  };
  window.umfaerben = () => document.getElementById('karo').style.setProperty('--farbe', 'rgb(200, 0, 0)');
</script>`;

// Fremde Herkunft mit CORS: ohne CSP wuerde das Modul laden
const foreignRequests = [];
const { url: foreignURL } = await serve((req, res) => {
  foreignRequests.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }).end(BLOB_WORKLET);
});

let karoRequests = 0;
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/karo.js') {
    karoRequests++;
    return res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(WORKLET);
  }
  if (path === '/nochmal.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(AGAIN_WORKLET);
  if (path === '/umleitung.js')
    return res.writeHead(302, { Location: foreignURL + 'umgeleitet.js' }).end();
  if (path === '/kaputt.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('registerPaint(');
  if (path === '/text.txt')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(WORKLET);
  if (path === '/') {
    const csp = "script-src 'self' 'unsafe-inline' blob:";
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp })
      .end(PAGE.replace('FREMD', JSON.stringify(foreignURL + 'direkt.js')));
  }
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'paintworklet-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });

for (const compositing of ['1', '0']) {
  const label = compositing === '1' ? 'mit Compositing' : 'ohne Compositing';
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const results = collect(page);
  const pixelAt = (x, y) => pagePixel(page, x, y);
  karoRequests = 0;
  foreignRequests.length = 0;
  await page.goto(stack.app({ url: siteURL, compositing }));

  check(`${label}: CSS.paintWorklet da`, await results.wait('api') === '1');
  check(`${label}: Modul ueber URL geladen`, await results.wait('url') === '1', results.get('url'));
  check(`${label}: Modul als Blob geladen`, await results.wait('blob') === '1', results.get('blob'));
  check(`${label}: 404 lehnt ab (AbortError)`, await results.wait('missing') === 'AbortError', results.get('missing'));
  check(`${label}: falscher MIME-Typ lehnt ab`, await results.wait('mime') === 'AbortError', results.get('mime'));
  check(`${label}: Syntaxfehler lehnt ab`, await results.wait('syntax') === 'AbortError', results.get('syntax'));
  check(`${label}: gleiche URL nur einmal geladen`, karoRequests === 1, String(karoRequests));
  check(`${label}: CSP verbietet fremde URL`, await results.wait('csp') === 'SecurityError', results.get('csp'));
  check(`${label}: CSP gilt nach Umleitung`, await results.wait('cspredirect') === 'AbortError' && foreignRequests.length === 0,
    `${results.get('cspredirect')} ${foreignRequests.join(' ')}`);

  await waitFor(async () => near(await pixelAt(70, 40), [0, 200, 0]));
  const top = await pixelAt(70, 40), bottom = await pixelAt(70, 100);
  check(`${label}: paint() malt (inputProperties)`, near(top, [0, 200, 0]) && near(bottom, [0, 0, 255]), JSON.stringify({ top, bottom }));
  const layerTop = await pixelAt(210, 40), layerBottom = await pixelAt(210, 100);
  check(`${label}: paint() in eigener Ebene`, near(layerTop, [255, 160, 0]) && near(layerBottom, [0, 0, 255]), JSON.stringify({ layerTop, layerBottom }));
  const stripe = await pixelAt(350, 70);
  check(`${label}: paint() mit Argument`, near(stripe, [255, 0, 255]), JSON.stringify(stripe));

  await page.evaluate(() => window.blTest.eval('umfaerben()'));
  let changed = null;
  await waitFor(async () => near(changed = await pixelAt(70, 40), [200, 0, 0]), 10000);
  check(`${label}: neu gemalt nach Aenderung von --farbe`, near(changed, [200, 0, 0]), JSON.stringify(changed));
  // Weitere Module mit dem Namen karo: kein Leck (vorher ca. 7 MB je Modul), es bleibt die erste Registrierung
  const memory = () => page.evaluate(() => window.blTest.browser.debug.module._bl_memory_used());
  const before = await memory();
  await page.evaluate(() => window.blTest.eval('nochmal(20)'));
  check(`${label}: Name in weiteren Modulen`, await results.wait('again') === '1', results.get('again'));
  const grown = (await memory() - before) / 1048576;
  check(`${label}: kein Speicherleck bei doppeltem Namen`, grown < 40, `${grown.toFixed(1)} MB`);
  const kept = await pixelAt(70, 40);
  check(`${label}: erste Registrierung bleibt`, near(kept, [200, 0, 0]), JSON.stringify(kept));
  await screenshot(page, `paintworklet-${compositing}`);
  await page.close();
}

await browser.close();
finish();
