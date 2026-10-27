// CSS paint worklets (CSS.paintWorklet, paint() in CSS, patch 0034): load a script by URL and as
// a blob, colors from inputProperties and inputArguments, repaint after a property change, an
// element in its own layer, load errors (404, wrong type, syntax error), every URL loaded only
// once, an already registered name in more modules without a memory leak, CSP also after a
// redirect. With and without compositing.
//
//   node tests/core/paintworklet-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  check,
  collect,
  finish,
  launch,
  near,
  openHost,
  shownPixel,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

// Top the color of --color, bottom blue.
const WORKLET = `registerPaint('checker', class {
  static get inputProperties() { return ['--color']; }
  paint(ctx, size, props) {
    ctx.fillStyle = String(props.get('--color')).trim();
    ctx.fillRect(0, 0, size.width, size.height / 2);
    ctx.fillStyle = 'rgb(0, 0, 255)';
    ctx.fillRect(0, size.height / 2, size.width, size.height / 2);
  }
});`;

// Registers checker once more (the first registration stays)
const AGAIN_WORKLET = `registerPaint('checker', class {
  paint(ctx, size) { ctx.fillStyle = 'rgb(0, 0, 0)'; ctx.fillRect(0, 0, size.width, size.height); }
});`;

// Color as the argument of paint(stripes, <color>)
const BLOB_WORKLET = `registerPaint('stripes', class {
  static get inputArguments() { return ['<color>']; }
  paint(ctx, size, props, args) {
    ctx.fillStyle = String(args[0]).trim();
    ctx.fillRect(0, 0, size.width, size.height);
  }
});`;

const PAGE = `<!doctype html><title>Paint worklet test</title>
<style>
  body { margin: 0; background: #fff; }
  .box { position: absolute; top: 20px; width: 100px; height: 100px; }
  #checker { left: 20px; background-image: paint(checker); --color: rgb(0, 200, 0); }
  #layer { left: 160px; background-image: paint(checker); --color: rgb(255, 160, 0); will-change: transform; }
  #stripes { left: 300px; background-image: paint(stripes, rgb(255, 0, 255)); }
</style>
<div class="box" id="checker"></div>
<div class="box" id="layer"></div>
<div class="box" id="stripes"></div>
<script>
  const result = (key, value) => console.log('RESULT ' + key + '=' + value);
  const failure = (key) => (e) => result(key, e && e.name);
  result('api', typeof CSS.paintWorklet === 'object' && typeof CSS.paintWorklet.addModule === 'function' ? 1 : 0);
  // The same URL three times: two at once, one after loading
  Promise.all([CSS.paintWorklet.addModule('checker.js'), CSS.paintWorklet.addModule('checker.js')])
    .then(() => CSS.paintWorklet.addModule('checker.js')).then(() => result('url', 1), failure('url'));
  const blob = new Blob([${JSON.stringify(BLOB_WORKLET)}], { type: 'text/javascript' });
  CSS.paintWorklet.addModule(URL.createObjectURL(blob)).then(() => result('blob', 1), failure('blob'));
  CSS.paintWorklet.addModule('missing.js').then(() => result('missing', 'ok'), failure('missing'));
  CSS.paintWorklet.addModule('text.txt').then(() => result('mime', 'ok'), failure('mime'));
  CSS.paintWorklet.addModule('broken.js').then(() => result('syntax', 'ok'), failure('syntax'));
  CSS.paintWorklet.addModule(FOREIGN).then(() => result('csp', 'ok'), failure('csp'));
  CSS.paintWorklet.addModule('redirect.js').then(() => result('cspredirect', 'ok'), failure('cspredirect'));
  window.again = async (count) => {
    try {
      for (let i = 0; i < count; i++)
        await CSS.paintWorklet.addModule('again.js?' + i);
      result('again', 1);
    } catch (e) { result('again', e && e.name); }
  };
  window.recolor = () => document.getElementById('checker').style.setProperty('--color', 'rgb(200, 0, 0)');
</script>`;

// Foreign origin with CORS: without the CSP the module would load
const foreignRequests = [];
const { url: foreignURL } = await serve((req, res) => {
  foreignRequests.push(req.url);
  res
    .writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' })
    .end(BLOB_WORKLET);
});

let checkerRequests = 0;
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/checker.js') {
    checkerRequests++;
    return res
      .writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
      .end(WORKLET);
  }
  if (path === '/again.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(AGAIN_WORKLET);
  if (path === '/redirect.js')
    return res.writeHead(302, { Location: foreignURL + 'redirected.js' }).end();
  if (path === '/broken.js')
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('registerPaint(');
  if (path === '/text.txt')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(WORKLET);
  if (path === '/') {
    const csp = "script-src 'self' 'unsafe-inline' blob:";
    return res
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
      })
      .end(PAGE.replace('FOREIGN', JSON.stringify(foreignURL + 'direct.js')));
  }
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'paintworklet-token-0123456789abcdef' });
const browser = await launch({ args: SWIFTSHADER });

for (const compositing of ['1', '0']) {
  const label = compositing === '1' ? 'with compositing' : 'without compositing';
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const results = collect(page);
  const pixelAt = (x, y) => shownPixel(page, x, y);
  checkerRequests = 0;
  foreignRequests.length = 0;
  await openHost(page, stack.app({ url: siteURL, compositing }));

  check(`${label}: CSS.paintWorklet there`, (await results.wait('api')) === '1');
  check(`${label}: module loaded by URL`, (await results.wait('url')) === '1', results.get('url'));
  check(
    `${label}: module loaded as a blob`,
    (await results.wait('blob')) === '1',
    results.get('blob'),
  );
  check(
    `${label}: 404 rejects (AbortError)`,
    (await results.wait('missing')) === 'AbortError',
    results.get('missing'),
  );
  check(
    `${label}: wrong MIME type rejects`,
    (await results.wait('mime')) === 'AbortError',
    results.get('mime'),
  );
  check(
    `${label}: syntax error rejects`,
    (await results.wait('syntax')) === 'AbortError',
    results.get('syntax'),
  );
  check(`${label}: the same URL loaded only once`, checkerRequests === 1, String(checkerRequests));
  check(
    `${label}: CSP forbids a foreign URL`,
    (await results.wait('csp')) === 'SecurityError',
    results.get('csp'),
  );
  check(
    `${label}: CSP applies after a redirect`,
    (await results.wait('cspredirect')) === 'AbortError' && foreignRequests.length === 0,
    `${results.get('cspredirect')} ${foreignRequests.join(' ')}`,
  );

  await waitFor(async () => near(await pixelAt(70, 40), [0, 200, 0]));
  const top = await pixelAt(70, 40),
    bottom = await pixelAt(70, 100);
  check(
    `${label}: paint() paints (inputProperties)`,
    near(top, [0, 200, 0]) && near(bottom, [0, 0, 255]),
    JSON.stringify({ top, bottom }),
  );
  const layerTop = await pixelAt(210, 40),
    layerBottom = await pixelAt(210, 100);
  check(
    `${label}: paint() in its own layer`,
    near(layerTop, [255, 160, 0]) && near(layerBottom, [0, 0, 255]),
    JSON.stringify({ layerTop, layerBottom }),
  );
  const stripe = await pixelAt(350, 70);
  check(`${label}: paint() with an argument`, near(stripe, [255, 0, 255]), JSON.stringify(stripe));

  await page.evaluate(() => window.blTest.eval('recolor()'));
  let changed = null;
  await waitFor(async () => near((changed = await pixelAt(70, 40)), [200, 0, 0]), 10000);
  check(
    `${label}: repainted after a change of --color`,
    near(changed, [200, 0, 0]),
    JSON.stringify(changed),
  );
  // More modules with the name checker: no leak (before about 7 MB per module), the first
  // registration stays
  const memory = () => page.evaluate(() => window.blTest.browser.debug.memoryUsed());
  const before = await memory();
  await page.evaluate(() => window.blTest.eval('again(20)'));
  check(
    `${label}: name in more modules`,
    (await results.wait('again')) === '1',
    results.get('again'),
  );
  const grown = ((await memory()) - before) / 1048576;
  check(`${label}: no memory leak with a duplicate name`, grown < 40, `${grown.toFixed(1)} MB`);
  const kept = await pixelAt(70, 40);
  check(`${label}: the first registration stays`, near(kept, [200, 0, 0]), JSON.stringify(kept));
  await screenshot(page, `paintworklet-${compositing}`);
  await page.close();
}

await browser.close();
finish();
