// Smoke test of @browser-lite/core in Chromium: the test host page (tests/core/host) starts a
// browser through the public API with a real engine, a relay and local test pages, then checks
// rendering, navigation and title events, keyboard input, a download, a <select> popup through
// a request handler, Web Audio through the audio worklet, a media file through the service
// worker, option errors, crash detection, destroy() and a second createBrowser() without services
// (copy still reaches the host clipboard).
//
//   node tests/core/smoke-test.mjs [engine-dir]      (default build/webcore/bin)
// Environment: E2E_TIMEOUT (ms per wait, default 60000), E2E_VERBOSE=1, CHROMIUM_PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseRequest, serveStatic } from '../../relay/static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const WAIT = Number(process.env.E2E_TIMEOUT || 60000);
const VERBOSE = !!process.env.E2E_VERBOSE;
const children = new Set();
process.on('exit', () => {
  for (const child of children) child.kill();
});
setTimeout(() => {
  console.log('FAIL time limit for the whole test');
  process.exit(1);
}, WAIT * 8).unref();

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ------------------------------------------------------------- servers

// Test host: the repository with COOP/COEP, /engine/ from the engine build and the service
// worker of the core next to the host page (its scope covers the page)
const DIST = path.join(root, 'packages', 'core', 'dist');
const host = http.createServer((req, res) => {
  const request = parseRequest(req);
  if (!request) return res.writeHead(400).end();
  const file = request.path;
  let found;
  if (file.startsWith('/engine/'))
    found = serveStatic(req, res, engineDir, file.slice('/engine'.length), 'no-cache');
  else if (file === '/tests/core/host/sw.js' || file === '/tests/core/host/media-sw.js')
    found = serveStatic(req, res, path.join(DIST, 'sw'), `/${path.basename(file)}`, 'no-cache');
  else found = serveStatic(req, res, root, file, 'no-cache');
  if (!found) res.writeHead(404).end('not found');
});
const hostPort = await listen(host);

// Pages for the engine (reached through the relay)
function wav(seconds, rate = 22050, frequency = 440) {
  const frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000), 44 + i * 2);
  return buffer;
}
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
<p>findme findme findme</p>
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
const pages = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  if (url.pathname === '/device')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end("<title>device</title><script>document.title = [screen.width, screen.height, devicePixelRatio, matchMedia('(pointer: coarse)').matches, innerWidth, innerHeight, navigator.maxTouchPoints > 0].join(':');</script>");
  if (url.pathname === '/more') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(MORE);
  if (url.pathname === '/file.txt')
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello from the download');
  if (url.pathname === '/tone.wav') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!range)
      return res
        .writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': TONE.length, 'Accept-Ranges': 'bytes' })
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

// Relay without token, local addresses allowed (only for tests)
const relayPort = await freePort();
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'relay', 'server.mjs')], {
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1', RELAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', VERBOSE ? 'inherit' : 'ignore'],
  });
  children.add(child);
  child.stdout.on('data', (data) => {
    if (VERBOSE) process.stdout.write(`[relay] ${data}`);
    if (/laeuft|running|listening/i.test(String(data))) resolve();
  });
  child.on('exit', (code) => reject(new Error(`relay exited (${code})`)));
});

// ------------------------------------------------------------- browser

const oldEngine = !fs.readFileSync(path.join(engineDir, 'engine.js'), 'utf8').includes('blShutdown');
const query = new URLSearchParams({
  relay: `ws://127.0.0.1:${relayPort}/wisp/`,
  url: PAGE_URL,
  ...(oldEngine ? { legacyCloseCodes: '1' } : {}),
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
page.on('console', (message) => {
  if (VERBOSE) console.log('   [page]', message.text());
});
page.on('pageerror', (error) => console.log('   page error:', error.message));

const waitFor = (fn, arg, ms = WAIT) =>
  page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(
    () => true,
    () => false,
  );

try {
  await page.goto(`http://localhost:${hostPort}/tests/core/host/?${query}`);
  const started = await page.evaluate(() => window.blTest.ready);
  const startError = await page.evaluate(() => window.blTest.error);
  check('createBrowser resolves', started === true, startError ? JSON.stringify(startError) : '');
  if (!started) throw new Error('no browser');
  check('transport', true, await page.evaluate(() => window.blTest.transportKind));
  check('state ready', (await page.evaluate(() => window.blTest.browser.state)) === 'ready');

  // Navigation and title events, first paint, pixels of the page
  check(
    'navigation event',
    await waitFor((url) => window.blTest.events.includes(`navigation:${url}`), PAGE_URL),
  );
  check('title event', await waitFor(() => window.blTest.title === 'Core smoke'));
  check('load event', await waitFor(() => window.blTest.events.includes('load')));
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
      (url) => window.blTest.view.url === url && window.blTest.view.title === 'Core smoke',
      PAGE_URL,
    ),
  );

  // Keyboard into an input of the page
  await page.mouse.click(250, 35);
  await page.waitForTimeout(300);
  await page.keyboard.type('hello');
  check('typing into an input', await waitFor(() => window.blTest.title === 'typed:hello'));
  check('user-activation event', await page.evaluate(() => window.blTest.events.includes('user-activation')));

  // <select> popup through the selectPopup handler
  await page.evaluate(() => {
    window.blTest.selectAnswer = 2;
  });
  await page.mouse.click(250, 95);
  check('select popup handler called', await waitFor(() => window.blTest.selectRequests.length > 0));
  const request = await page.evaluate(() => window.blTest.selectRequests[0]);
  check('select request data', request?.items?.join() === 'zero,one,two' && request.selectedIndex === 0, JSON.stringify(request));
  check('select answer reaches the page', await waitFor(() => window.blTest.title === 'select:two'));

  // Download through the download event
  await page.mouse.click(250, 155);
  check('download event', await waitFor(() => window.blTest.downloads.length > 0));
  check(
    'download done',
    await waitFor(() => window.blTest.downloads[0]?.text === 'hello from the download'),
    JSON.stringify(await page.evaluate(() => window.blTest.downloads[0])),
  );

  // Web Audio: the audio worklet of the core plays what the page renders
  await page.mouse.click(250, 215);
  check('audio click', await waitFor(() => window.blTest.title === 'beep'));
  check(
    'audio worklet runs',
    await waitFor(() => {
      const state = window.blTest.browser.debug.audioState();
      return state.outputs > 0 && state.state === 'running' && state.peak > 0.01;
    }, undefined, 20000),
    JSON.stringify(await page.evaluate(() => window.blTest.browser.debug.audioState())),
  );

  // Media file through the service worker of the core (prefix from its scope)
  check(
    'media plays through the service worker',
    await waitFor(() => {
      const players = window.blTest.browser.debug.mediaState();
      return players.length > 0 && players.some((player) => player.time > 0.5);
    }, undefined, 30000),
    JSON.stringify(await page.evaluate(() => window.blTest.browser.debug.mediaState())),
  );
  check('no warnings', (await page.evaluate(() => window.blTest.warnings.join())) === '', await page.evaluate(() => window.blTest.warnings.join()));

  // ---------------------------------------------------------- second page
  const MORE_URL = `${PAGE_URL}more`;
  await page.evaluate((url) => window.blTest.open(url), MORE_URL);
  check('second page loads', await waitFor(() => window.blTest.title === 'More'));
  check('console event', await waitFor(() => window.blTest.events.includes('console:log:more console')));

  await page.evaluate(() => window.blTest.view.find('findme'));
  check('find event', await waitFor(() => window.blTest.events.includes('find:3')));
  await page.evaluate(() => window.blTest.view.stopFind());

  await page.evaluate(() => window.blTest.view.print());
  check('print event with a PDF', await waitFor(() => window.blTest.events.includes('print:application/pdf:true')));

  await page.evaluate(() => window.blTest.view.viewSource());
  check('source event', await waitFor(() => window.blTest.source?.includes('<title>More</title>')));

  await page.evaluate(() => window.blTest.view.setZoom(1.5));
  check('zoom event', await page.evaluate(() => window.blTest.events.includes('zoom:1.5') && window.blTest.view.zoom === 1.5));
  await page.evaluate(() => window.blTest.view.setZoom(1));

  // File chooser handler -> upload into the engine file system -> File in the page
  await page.evaluate(() => {
    window.blTest.fileAnswer = [['a.txt', 'abc']];
  });
  await page.mouse.click(250, 35);
  check('file chooser handler', await waitFor(() => window.blTest.events.includes('filechooser:false')));
  check('uploaded file reaches the page', await waitFor(() => window.blTest.title === 'file:a.txt:abc'));

  // Dialog handler (synchronous)
  await page.mouse.click(250, 95);
  check('dialogs answered by the handler', await waitFor(() => window.blTest.title === 'dialogs:true:answer'));
  check(
    'dialog requests',
    await page.evaluate(() => ['dialog:alert:a', 'dialog:confirm:c', 'dialog:prompt:p'].every((e) => window.blTest.events.includes(e))),
  );

  // Permission handler + geolocation of the devices service
  await context.grantPermissions(['geolocation'], { origin: `http://localhost:${hostPort}` });
  await context.setGeolocation({ latitude: 47.25, longitude: 8.5 });
  await page.evaluate(() => {
    window.blTest.permissionAnswer = 'grant';
  });
  await page.mouse.click(250, 155);
  check('permission handler', await waitFor(() => window.blTest.events.includes('permission:geolocation')));
  check('geolocation through the host', await waitFor(() => window.blTest.title === 'geo:47.25'), await page.evaluate(() => window.blTest.title));

  // Context menu request
  await page.mouse.click(500, 400, { button: 'right' });
  check('context-menu event', await waitFor(() => window.blTest.events.some((e) => e.startsWith('context-menu:500,400'))));

  // window.open: new-view, attach, close
  await page.mouse.click(250, 215);
  check('new-view event', await waitFor(() => window.blTest.events.some((e) => e.startsWith('new-view:'))));
  const popup = await page.evaluate(async () => {
    const view = window.blTest.views[0];
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:0;bottom:0;width:300px;height:200px';
    document.body.append(box);
    view.attach(box);
    return { id: view.id, opener: window.blTest.events.find((e) => e.startsWith('new-view:')) };
  });
  check('new view has its opener', popup.opener === `new-view:${await page.evaluate(() => window.blTest.view.id)}`, JSON.stringify(popup));
  check('new view navigates', await waitFor((url) => window.blTest.events.includes(`popup-navigation:${url}`), PAGE_URL));
  const closed = await page.evaluate(() => window.blTest.views[0].close());
  check('close() of the new view', closed === true && (await page.evaluate(() => window.blTest.events.includes('popup-close') && !window.blTest.browser.views.has(window.blTest.views[0].id))));
  await page.evaluate(() => window.blTest.view.focus());

  // Paste through the API
  await page.mouse.click(250, 335);
  await page.evaluate(() => window.blTest.view.paste('pasted'));
  check('paste()', await waitFor(() => window.blTest.title === 'text:pasted'));

  // History
  await page.evaluate(() => window.blTest.view.back());
  check('back()', await waitFor((url) => window.blTest.view.url === url && window.blTest.view.canGoForward, PAGE_URL));
  await page.evaluate(() => window.blTest.view.forward());
  check('forward()', await waitFor((url) => window.blTest.view.url === url && !window.blTest.view.canGoForward, MORE_URL));
  check('history', await page.evaluate(() => window.blTest.view.history?.entries?.length >= 2), JSON.stringify(await page.evaluate(() => window.blTest.view.history)));

  // Watchdog: a busy page does not answer input for more than 10 s
  await page.mouse.click(250, 275);
  await page.waitForTimeout(500);
  await page.keyboard.press('a');
  check('unresponsive event', await waitFor(() => window.blTest.events.includes('unresponsive'), undefined, 15000));
  check('responsive event', await waitFor(() => window.blTest.events.includes('responsive'), undefined, 15000));
  check('page runs again after the hang', await waitFor(() => window.blTest.title === 'hang done'));

  await page.evaluate(() => window.blTest.browser.debug.memoryPressure());
  check('memory-pressure event (debug)', await page.evaluate(() => window.blTest.events.includes('memory-pressure')));
  check('debug memory', (await page.evaluate(() => window.blTest.browser.debug.memory())) > 1e8);

  // API errors
  const errors = await page.evaluate(async () => {
    const { createBrowser, clearStorage } = await import('@browser-lite/core');
    const codeOf = (promise) => promise.then(() => 'resolved', (error) => error.code);
    const transport = new EventTarget();
    transport.openTCP = () => {};
    transport.connected = true;
    return {
      running: await codeOf(createBrowser({ engineUrl: '/engine/', transport })),
      namespace: await codeOf(createBrowser({ engineUrl: '/engine/', transport, storage: { namespace: 'Bad!' } })),
      env: await codeOf(createBrowser({ engineUrl: '/engine/', transport, engine: { env: { BL_FEATURES: '' } } })),
      crossOrigin: await codeOf(createBrowser({ engineUrl: 'https://example.com/engine/', transport })),
      clear: await codeOf(clearStorage('Bad!')),
    };
  });
  check('second createBrowser while running: already-running', errors.running === 'already-running', errors.running);
  check('bad namespace: invalid-options', errors.namespace === 'invalid-options', errors.namespace);
  check('core-owned env key: invalid-options', errors.env === 'invalid-options', errors.env);
  check('cross-origin engine: invalid-options', errors.crossOrigin === 'invalid-options', errors.crossOrigin);
  check('clearStorage bad namespace: invalid-options', errors.clear === 'invalid-options', errors.clear);

  // A trap in WebAssembly of the embedding page is no engine crash
  await page.evaluate(() => {
    const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 5, 1, 3, 0, 0, 0x0b];
    const { f } = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes))).exports;
    setTimeout(f);
  });
  await page.waitForTimeout(500);
  check('foreign WebAssembly trap is no crash', (await page.evaluate(() => window.blTest.browser.state)) === 'ready');

  // Crash (engine test hook, needs debug): crash event, state crashed
  await page.evaluate(() => window.blTest.browser.debug.crash('abort'));
  check('crash event', await waitFor(() => window.blTest.events.some((e) => e.startsWith('crash:'))));
  const crashed = await page.evaluate(() => {
    let code = '';
    try {
      window.blTest.browser.createView();
    } catch (error) {
      code = error.code;
    }
    return { state: window.blTest.browser.state, code };
  });
  check('crashed state', crashed.state === 'crashed' && crashed.code === 'crashed', JSON.stringify(crashed));

  // destroy() and a new browser on the same page
  const destroyed = await page.evaluate(async () => {
    const browser = window.blTest.browser;
    const view = window.blTest.view;
    await window.blTest.stop();
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
      events: window.blTest.events.includes('close'),
    };
  });
  check('destroy: state destroyed', destroyed.state === 'destroyed', JSON.stringify(destroyed));
  check('destroy: view closed and canvas removed', destroyed.closed && destroyed.canvases === 0 && destroyed.events);
  check('createView after destroy: destroyed', destroyed.code === 'destroyed');
  // The second browser runs without services: copy in a page still reaches the host clipboard
  const second = await page.evaluate(() => window.blTest.start({ services: [] }).then(() => 'ready', () => window.blTest.error?.code));
  if (oldEngine) {
    check('second createBrowser with an engine without blShutdown: already-running', second === 'already-running', second);
  } else {
    check('second createBrowser after destroy', second === 'ready', second);
    if (second === 'ready') {
      await page.evaluate((url) => window.blTest.open(url), PAGE_URL);
      check(
        'second browser renders',
        await waitFor(() => {
          const [r, g, b] = window.blTest.pagePixel(50, 50);
          return r > 200 && g < 60 && b < 60;
        }),
      );
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${hostPort}` });
      await page.evaluate((url) => window.blTest.open(url), MORE_URL);
      await waitFor(() => window.blTest.title === 'More');
      await page.evaluate(() => {
        window.blTest.view.command('SelectAll');
        window.blTest.view.command('Copy');
      });
      check(
        'copy reaches the host clipboard without devices()',
        await waitFor(async () => (await navigator.clipboard.readText().catch(() => '')).includes('findme'), undefined, 10000),
        await page.evaluate(() => navigator.clipboard.readText().catch((error) => error.message)),
      );
      // A WebAssembly trap in the engine thread (worker error event) is a crash
      await page.evaluate(() => window.blTest.browser.debug.crash('trap'));
      check(
        'trap in the engine: crash event',
        await waitFor(() => window.blTest.events.filter((e) => e.startsWith('crash:')).length === 2),
        await page.evaluate(() => window.blTest.events.filter((e) => e.startsWith('crash:')).join(' | ')),
      );
    }
  }

  // Storage: OPFS namespace, Web Lock across tabs, beforeStart, clearStorage; device emulation
  const storageQuery = (extra) =>
    `http://localhost:${hostPort}/tests/core/host/?${new URLSearchParams({ ...Object.fromEntries(query), persistent: '1', ...extra })}`;
  const first = await context.newPage();
  await first.goto(storageQuery({ url: `${PAGE_URL}device`, device: '400x300x2' }));
  check('persistent browser starts', (await first.evaluate(() => window.blTest.ready)) === true, JSON.stringify(await first.evaluate(() => window.blTest.error)));
  const firstState = await first.evaluate(() => ({
    persistent: window.blTest.browser.storage.persistent,
    directory: window.blTest.browser.storage.directory?.name,
    beforeStart: window.blTest.beforeStart,
  }));
  check('storage namespace directory and beforeStart', firstState.persistent && firstState.directory === 'browserlite' && firstState.beforeStart === 'browserlite', JSON.stringify(firstState));
  check(
    'device emulation reaches the page',
    await first.waitForFunction(() => window.blTest.title?.startsWith('400:300:2:true:400:300'), undefined, { timeout: WAIT }).then(() => true, () => false),
    await first.evaluate(() => window.blTest.title),
  );
  const canvasSize = await first.evaluate(() => {
    const rect = window.blTest.view.canvas.getBoundingClientRect();
    return `${rect.width}x${rect.height}`;
  });
  check('device emulation limits the canvas', canvasSize === '400x300', canvasSize);
  const secondTab = await context.newPage();
  await secondTab.goto(storageQuery({ url: PAGE_URL }));
  check('second tab starts', (await secondTab.evaluate(() => window.blTest.ready)) === true);
  check(
    'second tab: warning storage-locked, memory only',
    await secondTab.waitForFunction(() => window.blTest.warnings.includes('storage-locked') && !window.blTest.browser.storage.persistent, undefined, { timeout: WAIT }).then(() => true, () => false),
  );
  const clearLocked = await secondTab.evaluate(async () => {
    const { clearStorage } = await import('@browser-lite/core');
    return clearStorage().then(() => 'cleared', (error) => error.code);
  });
  check('clearStorage while in use: storage-locked', clearLocked === 'storage-locked', clearLocked);
  await first.close({ runBeforeUnload: false });
  const cleared = await secondTab.evaluate(async () => {
    const { clearStorage } = await import('@browser-lite/core');
    for (let i = 0; i < 50; i++) {
      const result = await clearStorage().then(() => 'cleared', (error) => error.code);
      if (result !== 'storage-locked') return result;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return 'still locked';
  });
  check('clearStorage after the tab closed', cleared === 'cleared', cleared);
  await secondTab.close();
} catch (error) {
  check('test ran through', false, error.message);
} finally {
  await browser.close();
  host.close();
  pages.close();
}
console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
