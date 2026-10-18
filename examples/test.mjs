// Test of the examples in Chromium with a real engine.
// existing-site: server.mjs with the engine, sign-in and relay tokens (403 without), the browser
// in a section of a page renders a test page, a video plays through the media part of the site's
// own service worker, the iframe page and the page with a strict Content Security Policy render.
// minimal: copy-engine, vite build, and its preview (COOP/COEP on the engine files, sw.js) runs a
// page through browser-lite-server.
//
//   node examples/test.mjs [engine-dir]      (default build/webcore/bin)
// Environment: E2E_TIMEOUT (ms per wait, default 60000), E2E_VERBOSE=1, CHROMIUM_PATH.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
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
}, WAIT * 10).unref();

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

/** Runs a command to its end; rejects on a non-zero exit code. */
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: VERBOSE ? 'inherit' : 'ignore', ...options });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')}: exit ${code}`)),
    );
  });
}

/** Starts a long running process and resolves once a line of its output matches `ready`. */
function start(name, command, args, options, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    children.add(child);
    const onData = (data) => {
      if (VERBOSE) process.stdout.write(`[${name}] ${data}`);
      if (ready.test(String(data))) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${name} exited (${code})`)));
  });
}

/** Pixels of a PNG screenshot (8 bit RGB or RGBA, not interlaced). */
function decodePNG(png) {
  let width = 0;
  let height = 0;
  let channels = 4;
  const data = [];
  for (let pos = 8; pos < png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const chunk = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(chunk);
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (value + predicted) & 255;
    }
  }
  return (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
}

/** True once the element shows the red square of the test page at (50, 50). */
async function rendersRed(locator) {
  for (
    const end = Date.now() + WAIT;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 250))
  ) {
    const [r, g, b] = decodePNG(await locator.screenshot())(50, 50);
    if (r > 200 && g < 60 && b < 60) return true;
  }
  return false;
}

/** Status of a WebSocket upgrade: 101 or the HTTP status of the refusal. */
function upgradeStatus(url, origin) {
  return new Promise((resolve) => {
    const request = http.get(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', () => resolve(0));
  });
}

// ------------------------------------------------------------- test pages (through the relay)

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// WebM clip of 3 s, recorded with MediaRecorder in this Chromium
async function recordClip() {
  const recorder = await browser.newPage();
  const bytes = await recorder.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    const media = new MediaRecorder(canvas.captureStream(25), {
      mimeType: 'video/webm;codecs=vp8',
    });
    const chunks = [];
    media.ondataavailable = (event) => chunks.push(event.data);
    const timer = setInterval(() => {
      context.fillStyle = '#0000e0';
      context.fillRect(0, 0, 320, 240);
    }, 40);
    media.start(500);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await new Promise((resolve) => {
      media.onstop = resolve;
      media.stop();
    });
    clearInterval(timer);
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await recorder.close();
  return Buffer.from(bytes);
}
const CLIP = await recordClip();

const PAGE = `<!doctype html><title>Example page</title>
<style>body { margin: 0 } #red { position: absolute; left: 0; top: 0; width: 100px; height: 100px; background: #ff0000 }</style>
<div id="red"></div>`;
const VIDEO = `<!doctype html><title>video</title>
<video id="video" src="/clip.webm" muted loop playsinline width="320" height="240"></video>
<script>
const video = document.getElementById('video');
video.addEventListener('timeupdate', () => { if (video.currentTime > 0.5) document.title = 'video:playing'; });
video.play().catch((error) => { document.title = 'video:' + error.name; });
</script>`;
// Media Source Extensions: the host plays a MediaSource through a blob: URL
const MSE = `<!doctype html><title>mse</title>
<video id="video" muted playsinline width="320" height="240"></video>
<script>
const type = 'video/webm; codecs="vp8"';
const video = document.getElementById('video');
const source = new MediaSource();
video.src = URL.createObjectURL(source);
source.addEventListener('sourceopen', async () => {
  const buffer = source.addSourceBuffer(type);
  buffer.addEventListener('updateend', () => source.endOfStream(), { once: true });
  buffer.appendBuffer(await (await fetch('/clip.webm')).arrayBuffer());
  video.addEventListener('timeupdate', () => { if (video.currentTime > 0.5) document.title = 'mse:playing'; });
  video.play().catch((error) => { document.title = 'mse:' + error.name; });
});
</script>`;
// Web Audio through the audio worklet of the core, started by a click
const AUDIO = `<!doctype html><title>audio</title>
<style>body { margin: 0 } button { position: absolute; left: 0; top: 0; width: 200px; height: 100px }</style>
<button id="beep">beep</button>
<script>
document.getElementById('beep').addEventListener('click', async () => {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  oscillator.connect(context.destination);
  oscillator.start();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  document.title = 'audio:' + context.state;
});
</script>`;
const pages = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = { '/': PAGE, '/video': VIDEO, '/mse': MSE, '/audio': AUDIO }[url.pathname];
  if (html) return res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
  if (url.pathname === '/clip.webm') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!range)
      return res
        .writeHead(200, {
          'Content-Type': 'video/webm',
          'Content-Length': CLIP.length,
          'Accept-Ranges': 'bytes',
        })
        .end(CLIP);
    const first = Number(range[1]);
    const last = Math.min(range[2] ? Number(range[2]) : CLIP.length - 1, CLIP.length - 1);
    return res
      .writeHead(206, {
        'Content-Type': 'video/webm',
        'Content-Length': last - first + 1,
        'Content-Range': `bytes ${first}-${last}/${CLIP.length}`,
        'Accept-Ranges': 'bytes',
      })
      .end(CLIP.subarray(first, last + 1));
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => pages.listen(0, '127.0.0.1', resolve));
const PAGE_URL = `http://127.0.0.1:${pages.address().port}/`;

const minimalDir = path.join(here, 'minimal');
try {
  // ----------------------------------------------------------- existing-site
  const sitePort = await freePort();
  const SITE = `http://localhost:${sitePort}`;
  await start(
    'site',
    process.execPath,
    [path.join(here, 'existing-site', 'server.mjs')],
    {
      env: {
        ...process.env,
        ENGINE_DIR: engineDir,
        PORT: String(sitePort),
        PUBLIC_ORIGIN: SITE,
        RELAY_ALLOW_LOCAL: '1',
      },
    },
    /Listening/,
  );

  const appHead = await fetch(`${SITE}/app/`);
  check(
    'existing-site: /app/ is cross-origin isolated',
    appHead.headers.get('cross-origin-opener-policy') === 'same-origin' &&
      appHead.headers.get('cross-origin-embedder-policy') === 'require-corp',
  );
  check(
    'existing-site: own pages without COOP',
    !(await fetch(`${SITE}/`)).headers.has('cross-origin-opener-policy'),
  );
  check(
    'existing-site: /token without session is 401',
    (await fetch(`${SITE}/token`)).status === 401,
  );
  const login = await fetch(`${SITE}/login`, { method: 'POST', redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const tokenResponse = await fetch(`${SITE}/token`, { headers: { cookie } });
  const token = await tokenResponse.text();
  check(
    'existing-site: /token with session',
    tokenResponse.ok && token.includes('.'),
    String(tokenResponse.status),
  );
  const wisp = `${SITE}/app/wisp/`;
  check('existing-site: relay without token is 403', (await upgradeStatus(wisp, SITE)) === 403);
  check(
    'existing-site: relay with a wrong token is 403',
    (await upgradeStatus(`${wisp}?token=x.y`, SITE)) === 403,
  );
  check(
    'existing-site: relay from another origin is 403',
    (await upgradeStatus(`${wisp}?token=${token}`, 'http://evil.example')) === 403,
  );
  check(
    'existing-site: relay with token is 101',
    (await upgradeStatus(`${wisp}?token=${token}`, SITE)) === 101,
  );

  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const watch = (page) => {
    if (VERBOSE) page.on('console', (message) => console.log('   [page]', message.text()));
    page.on('pageerror', (error) => console.log('   page error:', error.message));
    return page;
  };
  // The browser box of the example pages: address form, title line, notice, view
  const titleOf = (target) => target.locator('.page-title').textContent();
  const titleIs = (target, text) =>
    target
      .locator('.page-title', { hasText: new RegExp(`^${text}$`) })
      .waitFor({ timeout: WAIT })
      .then(
        () => true,
        () => false,
      );
  const loadInBox = async (page, url) => {
    await page.fill('.address-form input', url);
    await page.press('.address-form input', 'Enter');
  };
  const withUrl = (pagePath, url = PAGE_URL) =>
    `${SITE}${pagePath}?${new URLSearchParams({ url })}`;

  // Signed out: the page says so and starts nothing
  const signedOut = watch(await context.newPage());
  await signedOut.goto(`${SITE}/app/`);
  check(
    'existing-site: signed out notice',
    await signedOut
      .locator('.notice', { hasText: 'Sign in' })
      .waitFor({ timeout: WAIT })
      .then(
        () => true,
        () => false,
      ),
  );
  await signedOut.close();

  // Sign in through the site's form, then the browser in a section of the page
  const page = watch(await context.newPage());
  await page.goto(`${SITE}/`);
  await page.click('text=Sign in (demo)');
  await page.waitForURL(`${SITE}/app/`);
  await page.goto(withUrl('/app/'));
  check('existing-site: crossOriginIsolated', await page.evaluate(() => crossOriginIsolated));
  check(
    'existing-site: title event of the test page',
    await titleIs(page, 'Example page'),
    await titleOf(page),
  );
  check('existing-site: page renders in the box', await rendersRed(page.locator('.view')));
  const worker = await page.evaluate(async () => ({
    script: navigator.serviceWorker.controller?.scriptURL ?? '',
    info: await fetch('sw-info.json').then(
      (r) => r.json(),
      () => null,
    ),
  }));
  check(
    "existing-site: the site's own service worker controls the page",
    worker.script.endsWith('/app/sw.js') && worker.info?.worker === 'example-site',
    JSON.stringify(worker),
  );
  await loadInBox(page, `${PAGE_URL}video`);
  check(
    'existing-site: video plays through the own service worker',
    await titleIs(page, 'video:playing'),
    await titleOf(page),
  );
  check(
    'existing-site: no warnings',
    await page.locator('.notice').isHidden(),
    await page.locator('.notice').textContent(),
  );
  await page.close();

  // The browser page in an iframe of an isolated parent
  const framed = watch(await context.newPage());
  await framed.goto(withUrl('/app/iframe.html'));
  const frame = framed.frameLocator('iframe.browser-frame');
  check('iframe: title event in the frame', await titleIs(frame, 'Example page'));
  check(
    'iframe: frame is cross-origin isolated',
    await framed.frames()[1]?.evaluate(() => crossOriginIsolated),
  );
  check('iframe: page renders in the frame', await rendersRed(frame.locator('.view')));
  await framed.close();

  // Strict Content Security Policy: everything works and nothing is refused
  const strict = watch(await context.newPage());
  await strict.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.log(`CSP violation: ${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  const violations = [];
  strict.on('console', (message) => {
    if (/Content Security Policy|Refused to|CSP violation/i.test(message.text()))
      violations.push(message.text());
  });
  const policy =
    (await strict.goto(withUrl('/app/csp.html')))?.headers()['content-security-policy'] ?? '';
  console.log(`   CSP: ${policy}`);
  check(
    'csp: policy header sent',
    policy.includes("'wasm-unsafe-eval'") && policy.includes("default-src 'none'"),
  );
  check(
    'csp: title event of the test page',
    await titleIs(strict, 'Example page'),
    await strict.locator('.notice').textContent(),
  );
  check('csp: page renders', await rendersRed(strict.locator('.view')));
  const box = await strict.locator('.view').boundingBox();
  await strict.mouse.click((box?.x ?? 0) + 400, (box?.y ?? 0) + 300, { button: 'right' });
  check(
    'csp: context menu of the ui',
    await strict
      .locator('.bl-context-menu')
      .waitFor({ timeout: WAIT })
      .then(
        () => true,
        () => false,
      ),
  );
  await strict.keyboard.press('Escape');
  await loadInBox(strict, `${PAGE_URL}video`);
  check('csp: video plays', await titleIs(strict, 'video:playing'), await titleOf(strict));
  await loadInBox(strict, `${PAGE_URL}mse`);
  check(
    'csp: Media Source Extensions play',
    await titleIs(strict, 'mse:playing'),
    await titleOf(strict),
  );
  await loadInBox(strict, `${PAGE_URL}audio`);
  await titleIs(strict, 'audio');
  await strict.mouse.click((box?.x ?? 0) + 100, (box?.y ?? 0) + 50);
  check('csp: Web Audio runs', await titleIs(strict, 'audio:running'), await titleOf(strict));
  check('csp: no violations', violations.length === 0, violations.join(' | '));
  await strict.close();
  await context.close();

  // ----------------------------------------------------------- minimal
  await run(process.execPath, [path.join(minimalDir, 'scripts', 'copy-engine.mjs')], {
    env: { ...process.env, ENGINE_DIR: engineDir },
  });
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  let built = true;
  await run(process.execPath, [vite, 'build'], { cwd: minimalDir }).catch((error) => {
    built = false;
    console.log(`   ${error.message}`);
  });
  check('minimal: vite build', built);
  if (!built) throw new Error('no build');

  const relayPort = await freePort();
  await start(
    'relay',
    process.execPath,
    [path.join(root, 'packages', 'server', 'dist', 'bin', 'browser-lite-server.js')],
    {
      env: {
        ...process.env,
        PORT: String(relayPort),
        HOST: '127.0.0.1',
        RELAY_ALLOW_LOCAL: '1',
        RELAY_TOKEN: '',
        RELAY_SECRET: '',
      },
    },
    /listening/i,
  );
  const previewPort = await freePort();
  await start(
    'preview',
    process.execPath,
    [vite, 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    { cwd: minimalDir, env: { ...process.env, RELAY_URL: `http://127.0.0.1:${relayPort}` } },
    new RegExp(String(previewPort)),
  );
  const PREVIEW = `http://localhost:${previewPort}`;
  const engineJs = await fetch(`${PREVIEW}/engine/engine.js`);
  check(
    'minimal: preview serves engine.js with COOP/COEP/CORP',
    engineJs.ok &&
      engineJs.headers.get('cross-origin-embedder-policy') === 'require-corp' &&
      engineJs.headers.get('cross-origin-opener-policy') === 'same-origin' &&
      engineJs.headers.get('cross-origin-resource-policy') === 'same-origin',
    `${engineJs.status} ${engineJs.headers.get('cross-origin-embedder-policy')}`,
  );
  const swFiles = await Promise.all(
    ['sw.js', 'media-sw.js'].map((file) => fetch(`${PREVIEW}/${file}`).then((r) => r.ok)),
  );
  check('minimal: sw.js and media-sw.js in the build', swFiles.every(Boolean));

  const minimalContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const minimal = watch(await minimalContext.newPage());
  await minimal.goto(`${PREVIEW}/?${new URLSearchParams({ url: PAGE_URL })}`);
  check(
    'minimal: title event reaches document.title',
    await minimal
      .waitForFunction(() => document.title === 'Example page', undefined, { timeout: WAIT })
      .then(
        () => true,
        () => false,
      ),
    (await minimal.locator('#message').textContent()) ?? '',
  );
  check('minimal: page renders', await rendersRed(minimal.locator('#view')));
  await minimalContext.close();
} catch (error) {
  check('test ran through', false, error.message);
} finally {
  await browser.close();
  pages.close();
  for (const child of children) child.kill();
  await rm(path.join(minimalDir, 'public', 'engine'), { recursive: true, force: true });
  await rm(path.join(minimalDir, 'dist'), { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
