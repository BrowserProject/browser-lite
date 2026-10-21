// Smoke test of @browser-lite/core in Chromium: the test host page (tests/core/host) starts a
// browser through the public API with a real engine, the relay of @browser-lite/server and local
// test pages, then checks rendering, navigation and title events, keyboard input, a download, a
// <select> popup through a request handler, Web Audio through the audio worklet, a media file
// through the service worker, the English error page, option errors, crash detection, destroy()
// and new browsers in the same page (without services: no features for the pages, copy still
// reaches the host clipboard; without a new-view listener a popup loads in its opener), dialogs
// answered later by a promise, permissions dismissed and set by setPermission, cancelling a
// download, storage namespaces and device emulation.
//
//   node tests/core/smoke-test.mjs [engine-dir]      (default build/webcore/bin)
// Environment: E2E_TIMEOUT (ms per wait, default 60000), E2E_VERBOSE=1, CHROMIUM_PATH.
import http from 'node:http';
import { check, finish, launch, startStack, wav } from '../lib/index.mjs';

const WAIT = Number(process.env.E2E_TIMEOUT || 60000);
const VERBOSE = !!process.env.E2E_VERBOSE;
setTimeout(() => {
  console.log('FAIL time limit for the whole test');
  process.exit(1);
}, WAIT * 8).unref();

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

// Pages for the engine (reached through the relay)
const TONE = wav(20);
const PAGE = `<!doctype html><title>Core smoke</title>
<style>
body { margin: 0; font: 16px sans-serif; background: #fff }
#red { position: absolute; left: 0; top: 0; width: 100px; height: 100px; background: #ff0000 }
#field { position: absolute; left: 150px; top: 20px; width: 200px; height: 30px }
#sel { position: absolute; left: 150px; top: 80px; width: 200px; height: 30px }
#dl { position: absolute; left: 150px; top: 140px; display: block; width: 200px; height: 30px; background: #ccc }
#beep { position: absolute; left: 150px; top: 200px; width: 200px; height: 30px }
</style>
<div id="red"></div>
<input id="field">
<select id="sel"><option>zero</option><option>one</option><option>two</option></select>
<a id="dl" href="/file.txt" download="hello.txt">download</a>
<button id="beep">beep</button>
<audio id="tone" src="/tone.wav" muted loop></audio>
<script>
const field = document.getElementById('field');
const sel = document.getElementById('sel');
field.addEventListener('input', () => { document.title = 'typed:' + field.value; });
sel.addEventListener('change', () => { document.title = 'select:' + sel.value; });
document.getElementById('beep').addEventListener('click', () => {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  oscillator.connect(context.destination);
  oscillator.start();
  document.title = 'beep';
});
document.getElementById('tone').play().then(() => console.log('tone playing'), (e) => console.log('tone ' + e.name));
</script>`;
// Second page: file chooser, dialogs, geolocation, popup, hang, paste, find
const MORE = `<!doctype html><title>More</title>
<style>
body { margin: 0; font: 16px sans-serif; background: #fff }
#file { position: absolute; left: 150px; top: 20px; width: 200px; height: 30px }
button, #text { position: absolute; left: 150px; width: 200px; height: 30px }
p { position: absolute; left: 400px; top: 20px }
</style>
<input id="file" type="file">
<button id="dialogs" style="top: 80px">dialogs</button>
<button id="geo" style="top: 140px">geo</button>
<button id="popup" style="top: 200px">popup</button>
<button id="hang" style="top: 260px">hang</button>
<input id="text" style="top: 320px">
<a id="slow" href="/slow.bin" download style="position: absolute; left: 150px; top: 380px; display: block; width: 200px; height: 30px; background: #ccc">slow</a>
<p title="find tip">findme findme findme</p>
<script>
const $ = (id) => document.getElementById(id);
console.log('more console');
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  document.title = 'file:' + file.name + ':' + (await file.text());
});
$('dialogs').addEventListener('click', () => {
  alert('a');
  const confirmed = confirm('c');
  const answer = prompt('p', 'd');
  document.title = 'dialogs:' + confirmed + ':' + answer;
});
$('geo').addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition((p) => { document.title = 'geo:' + p.coords.latitude; }, (e) => { document.title = 'geoerror:' + e.code; });
});
$('popup').addEventListener('click', () => window.open('/', '_blank'));
$('hang').addEventListener('click', () => {
  const end = Date.now() + 13000;
  while (Date.now() < end) {}
  document.title = 'hang done';
});
$('text').addEventListener('input', () => { document.title = 'text:' + $('text').value; });
</script>`;
// The slow download sends a chunk every 100 ms for 30 s; slowClosed: the engine hung up early
let slowClosed = false;
const pages = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/slow.bin') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': 300 * 1024,
    });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(1024, 1));
      if (++sent === 300) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.on('close', () => {
      clearInterval(timer);
      if (sent < 300) slowClosed = true;
    });
    return;
  }
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  if (url.pathname === '/device')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        "<title>device</title><script>document.title = [screen.width, screen.height, devicePixelRatio, matchMedia('(pointer: coarse)').matches, innerWidth, innerHeight, navigator.maxTouchPoints > 0].join(':');</script>",
      );
  if (url.pathname === '/more')
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(MORE);
  if (url.pathname === '/features')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        "<title>features</title><script>document.title = 'features:' + [typeof AudioContext, typeof navigator.getBattery, 'clipboard' in navigator, typeof EyeDropper, 'geolocation:' + typeof navigator.geolocation].join(':');</script>",
      );
  if (url.pathname === '/notify')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        "<title>notify</title><p>copy me</p><script>const n = new Notification('hello', { body: 'b', icon: 'https://tracker.invalid/i.png' }); n.onshow = () => { document.title = 'shown'; n.close(); }; n.onclose = () => { document.title = 'closed'; };</script>",
      );
  if (url.pathname === '/store')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        "<title>store</title><script>localStorage.setItem('kept', 'yes'); document.title = 'stored';</script>",
      );
  if (url.pathname === '/file.txt')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello from the download');
  if (url.pathname === '/tone.wav') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!range)
      return res
        .writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': TONE.length,
          'Accept-Ranges': 'bytes',
        })
        .end(TONE);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : TONE.length - 1, TONE.length - 1);
    return res
      .writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${TONE.length}`,
        'Accept-Ranges': 'bytes',
      })
      .end(TONE.subarray(start, end + 1));
  }
  res.writeHead(404).end();
});
const pagesPort = await listen(pages);
const PAGE_URL = `http://127.0.0.1:${pagesPort}/`;

// Test host page and relay of the server package (local addresses allowed, only for tests)
const stack = await startStack({ app: 'core' });
const ORIGIN = stack.origin;

// ------------------------------------------------------------- browser

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (message) => {
  consoleLines.push(message.text());
  if (VERBOSE) console.log('   [page]', message.text());
});
page.on('pageerror', (error) => console.log('   page error:', error.message));

async function waitForConsole(text, ms = WAIT) {
  for (
    const end = Date.now() + ms;
    Date.now() < end;
    await new Promise((resolve) => setTimeout(resolve, 100))
  )
    if (consoleLines.some((line) => line.includes(text))) return true;
  return false;
}

const waitFor = (fn, arg, ms = WAIT) =>
  page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(
    () => true,
    () => false,
  );

try {
  await page.goto(stack.app({ url: PAGE_URL }));
  const started = await page.evaluate(() => window.blHost.ready);
  const startError = await page.evaluate(() => window.blHost.error);
  check('createBrowser resolves', started === true, startError ? JSON.stringify(startError) : '');
  if (!started) throw new Error('no browser');
  check('state ready', (await page.evaluate(() => window.blTest.browser.state)) === 'ready');
  check(
    'blTest hook object',
    await page.evaluate(
      () =>
        [
          'view',
          'views',
          'open',
          'load',
          'eval',
          'pagePixel',
          'pageRow',
          'memory',
          'memoryPressure',
          'crash',
          'audioState',
          'mediaState',
          'rtcState',
          'measurements',
        ].every((name) => typeof window.blTest[name] === 'function') &&
        window.blTest.views().length === 1,
    ),
  );
  // Readings for tests/perf: start times of the engine and the core, memory size
  const start = await page.evaluate(() => ({
    engine: window.blTest.measurements(),
    marks: performance.getEntriesByType('mark').map((mark) => mark.name),
  }));
  check(
    'start readings',
    start.engine?.memoryBytes > 0 &&
      start.engine.main > 0 &&
      start.engine.ready >= start.engine.main &&
      start.engine.threadsBeforeReady > 0 &&
      ['bl:engine.js', 'bl:instantiate', 'bl:main', 'bl:ready', 'bl:prepared'].every((name) =>
        start.marks.includes(name),
      ),
    JSON.stringify(start),
  );

  // Navigation and title events, first paint, pixels of the page
  check(
    'navigation event',
    await waitFor((url) => window.blHost.events.includes(`navigation:${url}`), PAGE_URL),
  );
  check('title event', await waitFor(() => window.blTest.view()?.title === 'Core smoke'));
  check('load event', await waitFor(() => window.blHost.events.includes('load')));
  check(
    'page renders (pagePixel red)',
    await waitFor(() => {
      const [r, g, b] = window.blTest.pagePixel(50, 50);
      return r > 200 && g < 60 && b < 60;
    }),
    JSON.stringify(await page.evaluate(() => window.blTest.pagePixel(50, 50))),
  );
  check(
    'view properties',
    await page.evaluate(
      (url) => window.blTest.view().url === url && window.blTest.view().title === 'Core smoke',
      PAGE_URL,
    ),
  );

  // Keyboard into an input of the page
  await page.mouse.click(250, 35);
  await page.waitForTimeout(300);
  await page.keyboard.type('hello');
  check('typing into an input', await waitFor(() => window.blTest.view()?.title === 'typed:hello'));
  check(
    'user-activation event',
    await page.evaluate(() => window.blHost.events.includes('user-activation')),
  );

  // <select> popup through the selectPopup handler
  await page.evaluate(() => {
    window.blHost.selectAnswer = 2;
  });
  await page.mouse.click(250, 95);
  check(
    'select popup handler called',
    await waitFor(() => window.blHost.selectRequests.length > 0),
  );
  const request = await page.evaluate(() => window.blHost.selectRequests[0]);
  check(
    'select request data',
    request?.items?.join() === 'zero,one,two' && request.selectedIndex === 0,
    JSON.stringify(request),
  );
  check(
    'select answer reaches the page',
    await waitFor(() => window.blTest.view()?.title === 'select:two'),
  );

  // Download through the download event
  await page.mouse.click(250, 155);
  check('download event', await waitFor(() => window.blHost.downloads.length > 0));
  check(
    'download done',
    await waitFor(() => window.blHost.downloads[0]?.text === 'hello from the download'),
    JSON.stringify(await page.evaluate(() => window.blHost.downloads[0])),
  );

  // Web Audio: the audio worklet of the core plays what the page renders
  await page.mouse.click(250, 215);
  check('audio click', await waitFor(() => window.blTest.view()?.title === 'beep'));
  check(
    'audio worklet runs',
    await waitFor(
      () => {
        const state = window.blTest.audioState();
        return state.outputs > 0 && state.state === 'running' && state.peak > 0.01;
      },
      undefined,
      20000,
    ),
    JSON.stringify(await page.evaluate(() => window.blTest.audioState())),
  );

  // Media file through the service worker of the core (prefix from its scope)
  check(
    'media plays through the service worker',
    await waitFor(
      () => {
        const players = window.blTest.mediaState();
        return players.length > 0 && players.some((player) => player.time > 0.5);
      },
      undefined,
      30000,
    ),
    JSON.stringify(await page.evaluate(() => window.blTest.mediaState())),
  );
  check(
    'no warnings',
    (await page.evaluate(() => window.blHost.warnings.join())) === '',
    await page.evaluate(() => window.blHost.warnings.join()),
  );

  // ---------------------------------------------------------- second page
  const MORE_URL = `${PAGE_URL}more`;
  await page.evaluate((url) => window.blTest.load(url), MORE_URL);
  check('second page loads', await waitFor(() => window.blTest.view()?.title === 'More'));
  check(
    'console event',
    await waitFor(() => window.blHost.events.includes('console:log:more console')),
  );

  await page.evaluate(() => window.blTest.view().find('findme'));
  check('find event', await waitFor(() => window.blHost.events.includes('find:3')));
  await page.evaluate(() => window.blTest.view().stopFind());

  await page.evaluate(() => window.blTest.view().print());
  check(
    'print event with a PDF',
    await waitFor(() => window.blHost.events.includes('print:application/pdf:true')),
  );

  await page.evaluate(() => window.blTest.view().viewSource());
  check('source event', await waitFor(() => window.blHost.source?.includes('<title>More</title>')));

  await page.evaluate(() => window.blTest.view().setZoom(1.5));
  check(
    'zoom event',
    await page.evaluate(
      () => window.blHost.events.includes('zoom:1.5') && window.blTest.view().zoom === 1.5,
    ),
  );
  await page.evaluate(() => window.blTest.view().setZoom(1));

  // File chooser handler -> upload into the engine file system -> File in the page
  await page.evaluate(() => {
    window.blHost.fileAnswer = [['a.txt', 'abc']];
  });
  await page.mouse.click(250, 35);
  check(
    'file chooser handler',
    await waitFor(() => window.blHost.events.includes('filechooser:false')),
  );
  check(
    'uploaded file reaches the page',
    await waitFor(() => window.blTest.view()?.title === 'file:a.txt:abc'),
  );

  // Dialog handler (synchronous)
  await page.mouse.click(250, 95);
  check(
    'dialogs answered by the handler',
    await waitFor(() => window.blTest.view()?.title === 'dialogs:true:answer'),
  );
  check(
    'dialog requests',
    await page.evaluate(() =>
      ['dialog:alert:a', 'dialog:confirm:c', 'dialog:prompt:p'].every((e) =>
        window.blHost.events.includes(e),
      ),
    ),
  );

  // The dialog handler answers later (a promise): the host page keeps running meanwhile
  await page.evaluate(() => {
    window.blHost.dialogMode = 'async';
    window.blHost.dialogDelay = 1500;
    window.blHost.events.length = 0;
    window.blTest.eval("document.title = 'More'");
  });
  await waitFor(() => window.blTest.view()?.title === 'More');
  await page.mouse.click(250, 95);
  check(
    'async dialog: the request arrives',
    await waitFor(() => window.blHost.events.includes('dialog:alert:a')),
  );
  const startedAt = Date.now();
  await page.evaluate(() => 1);
  const hostDelay = Date.now() - startedAt;
  check('async dialog: the host page is not blocked', hostDelay < 500, `${hostDelay} ms`);
  check(
    'async dialog: answers reach the page',
    await waitFor(() => window.blTest.view()?.title === 'dialogs:true:answer'),
    await page.evaluate(() => window.blTest.view()?.title),
  );
  check(
    'async dialog: no unresponsive event',
    !(await page.evaluate(() => window.blHost.events.includes('unresponsive'))),
  );
  await page.evaluate(() => {
    window.blHost.dialogMode = 'answer';
  });

  // Permission handler + geolocation of the devices service: 'dismiss' is not remembered, so
  // the page asks again; setPermission decides without asking
  await context.grantPermissions(['geolocation'], { origin: ORIGIN });
  await context.setGeolocation({ latitude: 47.25, longitude: 8.5 });
  await page.evaluate(() => {
    window.blHost.permissionAnswer = 'dismiss';
  });
  await page.mouse.click(250, 155);
  check(
    'permission handler',
    await waitFor(() => window.blHost.events.includes('permission:geolocation')),
  );
  check(
    'dismissed permission: denied for now',
    await waitFor(() => window.blTest.view()?.title === 'geoerror:1'),
    await page.evaluate(() => window.blTest.view()?.title),
  );
  // A document keeps the answer of its first geolocation request: new documents from here on
  await page.evaluate((origin) => {
    window.blHost.permissionAnswer = 'deny';
    window.blTest.browser.setPermission(origin, 'geolocation', 'grant');
    window.blTest.view().reload();
  }, new URL(PAGE_URL).origin);
  await waitFor(() => window.blTest.view()?.title === 'More');
  await page.mouse.click(250, 155);
  check(
    'setPermission grant: geolocation through the host without asking',
    await waitFor(() => window.blTest.view()?.title === 'geo:47.25'),
    await page.evaluate(() => window.blTest.view()?.title),
  );
  check(
    'setPermission grant: asked only once',
    (await page.evaluate(
      () => window.blHost.events.filter((e) => e === 'permission:geolocation').length,
    )) === 1,
  );
  await page.evaluate((origin) => {
    window.blTest.browser.setPermission(origin, 'geolocation', null);
    window.blTest.view().reload();
  }, new URL(PAGE_URL).origin);
  await waitFor(() => window.blTest.view()?.title === 'More');
  await page.mouse.click(250, 155);
  check(
    'setPermission null: the page is asked again',
    await waitFor(
      () => window.blHost.events.filter((e) => e === 'permission:geolocation').length === 2,
    ),
  );
  check(
    'and the denial applies',
    await waitFor(() => window.blTest.view()?.title === 'geoerror:1'),
    await page.evaluate(() => window.blTest.view()?.title),
  );

  // Cancelling a running download stops the engine request
  const downloadsBefore = await page.evaluate(() => window.blHost.downloadObjects.length);
  await page.mouse.click(250, 395);
  check(
    'slow download starts',
    await waitFor((count) => window.blHost.downloadObjects.length > count, downloadsBefore),
  );
  await page.waitForTimeout(500);
  const cancelled = await page.evaluate(() => {
    const download = window.blHost.downloadObjects.at(-1);
    download.cancel();
    return { state: download.state, error: download.error, view: download.view?.id };
  });
  check(
    'cancel(): state error Cancelled',
    cancelled.state === 'error' && cancelled.error === 'Cancelled' && cancelled.view > 0,
    JSON.stringify(cancelled),
  );
  for (let i = 0; i < 50 && !slowClosed; i++) await page.waitForTimeout(100);
  check('cancel(): the engine closes the request', slowClosed);

  // Tooltip of the element under the mouse on the canvas
  await page.mouse.move(420, 40);
  await page.mouse.move(440, 45);
  check(
    'tooltip on the canvas',
    await waitFor(() => window.blTest.view().canvas.title === 'find tip'),
    await page.evaluate(
      () =>
        `"${window.blTest.view().canvas.title}" ${window.blHost.events.filter((e) => e.startsWith('hover')).join()}`,
    ),
  );

  // Context menu request
  await page.mouse.click(500, 400, { button: 'right' });
  check(
    'context-menu event',
    await waitFor(() => window.blHost.events.some((e) => e.startsWith('context-menu:500,400'))),
  );

  // window.open: new-view, the host makes it the active view, close
  const openerId = await page.evaluate(() => window.blTest.view().id);
  await page.mouse.click(250, 215);
  check(
    'new-view event',
    await waitFor(() => window.blHost.events.some((e) => e.startsWith('new-view:'))),
  );
  const popup = await page.evaluate(() => ({
    id: window.blTest.view().id,
    count: window.blTest.views().length,
    opener: window.blHost.events.find((e) => e.startsWith('new-view:')),
  }));
  check(
    'new view has its opener and is active',
    popup.opener === `new-view:${openerId}` && popup.id !== openerId && popup.count === 2,
    JSON.stringify(popup),
  );
  check(
    'new view navigates',
    await waitFor((url) => window.blHost.events.includes(`popup-navigation:${url}`), PAGE_URL),
  );
  const closed = await page.evaluate(() => window.blTest.view().close());
  const afterClose = await page.evaluate(
    (id) => ({
      closedEvent: window.blHost.events.includes('popup-close'),
      gone: !window.blTest.browser.views.has(id),
      active: window.blTest.view().id,
    }),
    popup.id,
  );
  check(
    'close() of the new view',
    closed === true && afterClose.closedEvent && afterClose.gone && afterClose.active === openerId,
    JSON.stringify(afterClose),
  );

  // Paste through the API
  await page.mouse.click(250, 335);
  await page.evaluate(() => window.blTest.view().paste('pasted'));
  check('paste()', await waitFor(() => window.blTest.view()?.title === 'text:pasted'));

  // History
  await page.evaluate(() => window.blTest.view().back());
  check(
    'back()',
    await waitFor(
      (url) => window.blTest.view().url === url && window.blTest.view().canGoForward,
      PAGE_URL,
    ),
  );
  await page.evaluate(() => window.blTest.view().forward());
  check(
    'forward()',
    await waitFor(
      (url) => window.blTest.view().url === url && !window.blTest.view().canGoForward,
      MORE_URL,
    ),
  );
  check(
    'history',
    await page.evaluate(() => window.blTest.view().history?.entries?.length >= 2),
    JSON.stringify(await page.evaluate(() => window.blTest.view().history)),
  );

  // Watchdog: a busy page does not answer input for more than 10 s
  await page.mouse.click(250, 275);
  await page.waitForTimeout(500);
  await page.keyboard.press('a');
  check(
    'unresponsive event',
    await waitFor(() => window.blHost.events.includes('unresponsive'), undefined, 15000),
  );
  check(
    'responsive event',
    await waitFor(() => window.blHost.events.includes('responsive'), undefined, 15000),
  );
  check(
    'page runs again after the hang',
    await waitFor(() => window.blTest.view()?.title === 'hang done'),
  );

  await page.evaluate(() => window.blTest.memoryPressure());
  check(
    'memory-pressure event (debug)',
    await page.evaluate(() => window.blHost.events.includes('memory-pressure')),
  );
  check('debug memory', (await page.evaluate(() => window.blTest.memory())) > 1e8);
  const used = await page.evaluate(() => window.blTest.browser.debug.memoryUsed());
  check(
    'debug memoryUsed',
    used > 1e6 && used < (await page.evaluate(() => window.blTest.memory())),
    String(used),
  );

  // Features of the default services reach the pages (webrtc is opt-in)
  await page.evaluate((url) => window.blTest.load(url), `${PAGE_URL}features`);
  check(
    'default services: features present',
    await waitFor(
      () =>
        window.blTest.view()?.title ===
        'features:function:function:true:function:geolocation:object',
    ),
    await page.evaluate(() => window.blTest.view()?.title),
  );

  // Error page of the engine (English default template) for a host that does not exist
  const FAILING_URL = 'http://does-not-exist.invalid/';
  await page.evaluate((url) => window.blTest.load(url), FAILING_URL);
  check(
    'error page commit',
    await waitFor(() => window.blHost.events.includes('commit:network')),
    await page.evaluate(() => window.blHost.events.filter((e) => e.startsWith('commit')).join()),
  );
  check(
    'error page keeps the address',
    await waitFor((url) => window.blTest.view().url === url, FAILING_URL),
  );
  await page.evaluate(() =>
    window.blTest.eval(
      "document.querySelector('h1').textContent + '|' + document.querySelector('.code').textContent",
    ),
  );
  check(
    'error page in English',
    await waitForConsole("This site can't be reached|ERR_NAME_NOT_RESOLVED"),
    consoleLines.filter((line) => line.includes('[eval')).join(' / '),
  );

  // GPU context loss of the engine (debug): the page is painted again afterwards
  await page.evaluate((url) => window.blTest.load(url), PAGE_URL);
  check('page again', await waitFor(() => window.blTest.view()?.title === 'Core smoke'));
  await page.evaluate(() => window.blTest.browser.debug.gpu('lose'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.blTest.browser.debug.gpu('restore'));
  await page.evaluate(() =>
    window.blTest.eval("document.getElementById('red').style.background = '#0000ff'"),
  );
  check(
    'renders after GPU context loss and restore',
    await waitFor(() => {
      const [r, g, b] = window.blTest.pagePixel(50, 50);
      return r < 60 && g < 60 && b > 200;
    }),
    JSON.stringify(await page.evaluate(() => window.blTest.pagePixel(50, 50))),
  );

  // API errors
  const errors = await page.evaluate(async () => {
    const { createBrowser, clearStorage } = await import('@browser-lite/core');
    const codeOf = (promise) =>
      promise.then(
        () => 'resolved',
        (error) => error.code,
      );
    const transport = new EventTarget();
    transport.openTCP = () => {};
    transport.connected = true;
    return {
      running: await codeOf(createBrowser({ engineUrl: '/engine/', transport })),
      namespace: await codeOf(
        createBrowser({ engineUrl: '/engine/', transport, storage: { namespace: 'Bad!' } }),
      ),
      env: await codeOf(
        createBrowser({ engineUrl: '/engine/', transport, engine: { env: { BL_FEATURES: '' } } }),
      ),
      crossOrigin: await codeOf(
        createBrowser({ engineUrl: 'https://example.com/engine/', transport }),
      ),
      clear: await codeOf(clearStorage('Bad!')),
    };
  });
  check(
    'second createBrowser while running: already-running',
    errors.running === 'already-running',
    errors.running,
  );
  check('bad namespace: invalid-options', errors.namespace === 'invalid-options', errors.namespace);
  check('core-owned env key: invalid-options', errors.env === 'invalid-options', errors.env);
  check(
    'cross-origin engine: invalid-options',
    errors.crossOrigin === 'invalid-options',
    errors.crossOrigin,
  );
  check(
    'clearStorage bad namespace: invalid-options',
    errors.clear === 'invalid-options',
    errors.clear,
  );

  // A trap in WebAssembly of the embedding page is no engine crash
  await page.evaluate(() => {
    const bytes = [
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0,
      0x0a, 5, 1, 3, 0, 0, 0x0b,
    ];
    const { f } = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes))).exports;
    setTimeout(f);
  });
  await page.waitForTimeout(500);
  check(
    'foreign WebAssembly trap is no crash',
    (await page.evaluate(() => window.blTest.browser.state)) === 'ready',
  );

  // Crash (engine test hook, needs debug): crash event with the WebAssembly stack in the reason,
  // state crashed
  await page.evaluate(() => window.blTest.crash('abort'));
  check(
    'crash event',
    await waitFor(() => window.blHost.events.some((e) => e.startsWith('crash:'))),
  );
  const crashReasons = () =>
    page.evaluate(() =>
      window.blHost.events.filter((e) => e.startsWith('crash:')).map((e) => e.slice(6)),
    );
  const [abortReason = ''] = await crashReasons();
  check(
    'crash reason of abort(): error and WebAssembly stack, bounded',
    abortReason.includes('Aborted(') &&
      /wasm-function\[\d+\]/.test(abortReason) &&
      abortReason.length <= 4096,
    abortReason.slice(0, 600),
  );
  const crashed = await page.evaluate(() => {
    let code = '';
    try {
      window.blTest.browser.createView();
    } catch (error) {
      code = error.code;
    }
    return { state: window.blTest.browser.state, code };
  });
  check(
    'crashed state',
    crashed.state === 'crashed' && crashed.code === 'crashed',
    JSON.stringify(crashed),
  );

  // destroy() and a new browser on the same page
  const destroyed = await page.evaluate(async () => {
    const browser = window.blTest.browser;
    const view = window.blTest.view();
    await window.blHost.stop();
    let code = '';
    try {
      browser.createView();
    } catch (error) {
      code = error.code;
    }
    return {
      state: browser.state,
      closed: view.closed,
      canvases: document.querySelectorAll('canvas').length,
      code,
      events: window.blHost.events.includes('close'),
    };
  });
  check('destroy: state destroyed', destroyed.state === 'destroyed', JSON.stringify(destroyed));
  check(
    'destroy: view closed and canvas removed',
    destroyed.closed && destroyed.canvases === 0 && destroyed.events,
  );
  check('createView after destroy: destroyed', destroyed.code === 'destroyed');
  // The second browser runs without services: no features for the pages, but copy in a page
  // still reaches the host clipboard
  const second = await page.evaluate(() => {
    window.blHost.listenNewView = false;
    return window.blHost.start({ services: [] }).then(
      () => 'ready',
      () => window.blHost.error?.code,
    );
  });
  check('second createBrowser after destroy', second === 'ready', second);
  if (second !== 'ready') throw new Error('no second browser');
  // Without a new-view listener a popup loads its address in the opener
  await page.evaluate((url) => window.blTest.load(url), `${PAGE_URL}more`);
  check(
    'second browser: page with a popup button',
    await waitFor(() => window.blTest.view()?.title === 'More'),
  );
  await page.mouse.click(250, 215);
  check(
    'no new-view listener: the popup address loads in the opener',
    await waitFor(
      (url) =>
        window.blTest.view()?.url === url &&
        window.blTest.view()?.title === 'Core smoke' &&
        window.blTest.browser.views.size === 1,
      PAGE_URL,
    ),
    await page.evaluate(() => `${window.blTest.view()?.url} ${window.blTest.browser.views.size}`),
  );
  await page.evaluate((url) => window.blTest.load(url), PAGE_URL);
  check(
    'second browser renders',
    await waitFor(() => {
      const [r, g, b] = window.blTest.pagePixel(50, 50);
      return r > 200 && g < 60 && b < 60;
    }),
  );
  await page.evaluate((url) => window.blTest.load(url), `${PAGE_URL}features`);
  check(
    'services: [] gives the pages no features',
    await waitFor(
      () =>
        window.blTest.view()?.title ===
        'features:undefined:undefined:false:undefined:geolocation:object',
    ),
    await page.evaluate(() => window.blTest.view()?.title),
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await page.evaluate((url) => window.blTest.load(url), MORE_URL);
  await waitFor(() => window.blTest.view()?.title === 'More');
  await page.evaluate(() => {
    window.blTest.view().command('SelectAll');
    window.blTest.view().command('Copy');
  });
  check(
    'copy reaches the host clipboard without devices()',
    await waitFor(
      async () => (await navigator.clipboard.readText().catch(() => '')).includes('findme'),
      undefined,
      10000,
    ),
    await page.evaluate(() => navigator.clipboard.readText().catch((error) => error.message)),
  );
  // A WebAssembly trap in the engine thread (worker error event) is a crash
  await page.evaluate(() => window.blTest.crash('trap'));
  check(
    'trap in the engine: crash event',
    await waitFor(() => window.blHost.events.filter((e) => e.startsWith('crash:')).length === 2),
    await page.evaluate(() =>
      window.blHost.events.filter((e) => e.startsWith('crash:')).join(' | '),
    ),
  );
  const trapReason = (await crashReasons())[1] ?? '';
  check(
    'crash reason of a trap: error and WebAssembly stack',
    trapReason.includes('unreachable') && /wasm-function\[\d+\]/.test(trapReason),
    trapReason.slice(0, 600),
  );
  // A crashed browser is destroyed and replaced in the same page, this time with handlers of
  // the integrator for notifications and copy
  const third = await page.evaluate(async () => {
    await window.blHost.stop();
    window.blHost.listenNewView = true;
    const { defaultServices, devices } = await import('@browser-lite/core');
    const shown = [];
    window.blHost.notifications = shown;
    window.blHost.copied = [];
    const notifications = {
      show(notification) {
        const { title, body, icon, view } = notification;
        shown.push(`${title}:${body}:${icon}:${view?.id ?? 0}`);
        notification.signal.addEventListener('abort', () => {
          shown.push('closed');
          notification.closed();
        });
        notification.shown();
      },
    };
    return window.blHost
      .start({
        services: [
          ...defaultServices().filter((service) => service.name !== 'devices'),
          devices({ notifications }),
        ],
        handlers: {
          clipboardWrite: ({ text }) => {
            window.blHost.copied.push(text);
          },
        },
      })
      .then(
        () => 'ready',
        () => window.blHost.error?.code,
      );
  });
  check('new browser after a crash', third === 'ready', third);
  check(
    'it renders',
    await waitFor(() => {
      const [r, g, b] = window.blTest.pagePixel(50, 50);
      return r > 200 && g < 60 && b < 60;
    }),
  );
  await page.evaluate((origin) => {
    window.blTest.browser.setPermission(origin, 'notifications', 'grant');
  }, new URL(PAGE_URL).origin);
  await page.evaluate((url) => window.blTest.load(url), `${PAGE_URL}notify`);
  check(
    'notification handler: shown, closed by the page',
    await waitFor(() => window.blTest.view()?.title === 'closed'),
    await page.evaluate(() => window.blTest.view()?.title),
  );
  const shown = await page.evaluate(() => ({
    list: window.blHost.notifications,
    view: window.blTest.view().id,
  }));
  check(
    'notification handler: data, view and no remote icon',
    shown.list.join('|') === `hello:b::${shown.view}|closed`,
    JSON.stringify(shown),
  );
  await page.evaluate(() => {
    window.blTest.view().command('SelectAll');
    window.blTest.view().command('Copy');
  });
  check(
    'clipboardWrite handler gets the copied text',
    await waitFor(() => window.blHost.copied.some((text) => text.includes('copy me'))),
    await page.evaluate(() => JSON.stringify(window.blHost.copied)),
  );
  await page.evaluate(() => window.blHost.stop());
  await page.close();

  // Storage: OPFS namespace, Web Lock across tabs, beforeStart, clearStorage; device emulation
  const storageQuery = (extra) => stack.app({ url: PAGE_URL, persistent: '1', ...extra });
  const first = await context.newPage();
  await first.goto(storageQuery({ url: `${PAGE_URL}device`, device: '400x300x2' }));
  check(
    'persistent browser starts',
    (await first.evaluate(() => window.blHost.ready)) === true,
    JSON.stringify(await first.evaluate(() => window.blHost.error)),
  );
  const firstState = await first.evaluate(() => ({
    persistent: window.blTest.browser.storage.persistent,
    directory: window.blTest.browser.storage.directory?.name,
    beforeStart: window.blHost.beforeStart,
  }));
  check(
    'storage namespace directory and beforeStart',
    firstState.persistent &&
      firstState.directory === 'browserlite' &&
      firstState.beforeStart === 'browserlite',
    JSON.stringify(firstState),
  );
  check(
    'device emulation reaches the page',
    await first
      .waitForFunction(
        () => window.blTest.view()?.title?.startsWith('400:300:2:true:400:300'),
        undefined,
        { timeout: WAIT },
      )
      .then(
        () => true,
        () => false,
      ),
    await first.evaluate(() => window.blTest.view()?.title),
  );
  const canvasSize = await first.evaluate(() => {
    const rect = window.blTest.view().canvas.getBoundingClientRect();
    return `${rect.width}x${rect.height}`;
  });
  check('device emulation limits the canvas', canvasSize === '400x300', canvasSize);
  const secondTab = await context.newPage();
  await secondTab.goto(storageQuery({ url: PAGE_URL }));
  check('second tab starts', (await secondTab.evaluate(() => window.blHost.ready)) === true);
  check(
    'second tab: warning storage-locked, memory only',
    await secondTab
      .waitForFunction(
        () =>
          window.blHost.warnings.includes('storage-locked') &&
          !window.blTest.browser.storage.persistent,
        undefined,
        { timeout: WAIT },
      )
      .then(
        () => true,
        () => false,
      ),
  );
  const clearLocked = await secondTab.evaluate(async () => {
    const { clearStorage } = await import('@browser-lite/core');
    return clearStorage().then(
      () => 'cleared',
      (error) => error.code,
    );
  });
  check('clearStorage while in use: storage-locked', clearLocked === 'storage-locked', clearLocked);
  await first.close({ runBeforeUnload: false });
  const cleared = await secondTab.evaluate(async () => {
    const { clearStorage } = await import('@browser-lite/core');
    for (let i = 0; i < 50; i++) {
      const result = await clearStorage().then(
        () => 'cleared',
        (error) => error.code,
      );
      if (result !== 'storage-locked') return result;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return 'still locked';
  });
  check('clearStorage after the tab closed', cleared === 'cleared', cleared);
  await secondTab.close();

  // Own storage namespace: OPFS directory, Cache API prefix, clearStorage(namespace)
  const NS = 'smoke_ns';
  const own = await context.newPage();
  await own.goto(storageQuery({ url: `${PAGE_URL}store`, namespace: NS }));
  check(
    'browser with its own namespace starts',
    (await own.evaluate(() => window.blHost.ready)) === true,
    JSON.stringify(await own.evaluate(() => window.blHost.error)),
  );
  const ownState = await own.evaluate(() => ({
    directory: window.blTest.browser.storage.directory?.name,
    beforeStart: window.blHost.beforeStart,
  }));
  check(
    'own namespace directory and beforeStart',
    ownState.directory === NS && ownState.beforeStart === NS,
    JSON.stringify(ownState),
  );
  check(
    'page stores in the own namespace',
    await own
      .waitForFunction(() => window.blTest.view()?.title === 'stored', undefined, { timeout: WAIT })
      .then(
        () => true,
        () => false,
      ),
  );
  const ownFiles = await own.evaluate(async (ns) => {
    window.blTest.browser.storage.flush(2000);
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    const files = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
        else files.push(prefix + name);
      }
    };
    await walk(await root.getDirectoryHandle(ns), '');
    return { names, files, caches: await caches.keys() };
  }, NS);
  check(
    'OPFS root holds the namespace directory with files',
    ownFiles.names.includes(NS) && ownFiles.files.length > 0,
    JSON.stringify(ownFiles),
  );
  check(
    'own namespace caches exist',
    ownFiles.caches.includes(`${NS}-http-v2`),
    ownFiles.caches.join(),
  );
  check(
    'caches only with the prefixes of the namespaces',
    ownFiles.caches.every((name) => name.startsWith(`${NS}-`) || name.startsWith('browserlite-')),
    ownFiles.caches.join(),
  );
  const ownCleared = await own.evaluate(async (ns) => {
    await window.blHost.stop();
    const { clearStorage } = await import('@browser-lite/core');
    const result = await clearStorage(ns).then(
      () => 'cleared',
      (error) => error.code,
    );
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    return {
      result,
      names,
      caches: (await caches.keys()).filter((name) => name.startsWith(`${ns}-`)),
    };
  }, NS);
  check(
    'clearStorage(namespace) removes directory and caches',
    ownCleared.result === 'cleared' &&
      !ownCleared.names.includes(NS) &&
      ownCleared.caches.length === 0,
    JSON.stringify(ownCleared),
  );
  await own.close();
} catch (error) {
  check('test ran through', false, error.message);
} finally {
  await browser.close();
  pages.close();
}
finish();
