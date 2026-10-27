// examples/existing-site in Chromium with a real engine: server.mjs with the engine, sign-in and
// relay tokens (403 without, never in the URL), the browser in a section of a page renders a test
// page, a video plays through the media part of the site's own service worker, the iframe page and
// the page with a strict Content Security Policy render.
//
//   node tests/examples/existing-site-test.mjs [engine-dir]
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {
  TIMEOUT,
  VERBOSE,
  check,
  engineDir,
  finish,
  freePort,
  launch,
  recordClip,
  root,
  serve,
  serveBytes,
  startProcess,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';
import { RED_PAGE, rendersRed } from './screen.mjs';

const WAIT = TIMEOUT;
timeLimit();

/** Status of a WebSocket upgrade: 101 or the HTTP status of the refusal. */
function upgradeStatus(url, origin, token) {
  return new Promise((resolve) => {
    const request = http.get(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        // As WispTransport sends a token
        ...(token
          ? {
              'Sec-WebSocket-Protocol': `wisp, bl-token.${Buffer.from(token).toString('base64url')}`,
            }
          : {}),
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

const browser = await launch();
const CLIP = await recordClip(browser);

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
const pages = await serve((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = { '/': RED_PAGE, '/video': VIDEO, '/mse': MSE, '/audio': AUDIO }[url.pathname];
  if (html) return res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
  if (url.pathname === '/clip.webm') return serveBytes(req, res, CLIP, 'video/webm');
  res.writeHead(404).end();
});
const PAGE_URL = pages.url;

try {
  const sitePort = await freePort();
  const SITE = `http://localhost:${sitePort}`;
  await startProcess(
    'site',
    process.execPath,
    [path.join(root, 'examples', 'existing-site', 'server.mjs')],
    {
      env: {
        ...process.env,
        ENGINE_DIR: engineDir,
        PORT: String(sitePort),
        PUBLIC_ORIGIN: SITE,
        RELAY_ALLOW_LOCAL: '1',
      },
      ready: /Listening/,
    },
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
  check(
    'existing-site: /session without session is 401',
    (await fetch(`${SITE}/session`)).status === 401,
  );
  check(
    'existing-site: CSP also on /app//csp.html',
    (await fetch(`${SITE}/app//csp.html`)).headers.has('content-security-policy'),
  );
  const login = await fetch(`${SITE}/login`, { method: 'POST', redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  check(
    'existing-site: /session with session is 204',
    (await fetch(`${SITE}/session`, { headers: { cookie } })).status === 204,
  );
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
    (await upgradeStatus(wisp, SITE, 'x.y')) === 403,
  );
  check(
    'existing-site: relay from another origin is 403',
    (await upgradeStatus(wisp, 'http://evil.example', token)) === 403,
  );
  check(
    'existing-site: relay with the token in the URL is 403',
    (await upgradeStatus(`${wisp}?token=${token}`, SITE)) === 403,
  );
  check('existing-site: relay with token is 101', (await upgradeStatus(wisp, SITE, token)) === 101);

  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const watch = (page) => {
    if (VERBOSE) page.on('console', (message) => console.log('   [page]', message.text()));
    watchErrors(page);
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
    // Firefox checks its own request of the site's /favicon.ico against the page's policy
    if (/favicon\.ico/.test(message.text())) return;
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
} catch (error) {
  check('test ran through', false, error.message);
} finally {
  await browser.close();
  pages.server.close();
}
finish();
