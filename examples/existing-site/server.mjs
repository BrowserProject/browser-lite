// An existing website with a Node backend that adds browser-lite under /app/:
//   /             the site's own pages (no special headers), /login and /logout
//   /token        short-lived relay token for signed-in users (session cookie)
//   /app/         browser pages, cross-origin isolated (COOP/COEP/CORP), the site's service worker
//   /app/wisp/    Wisp relay (WebSocket), only with a valid token and from the site's origin
//   /app/engine/  engine files from ENGINE_DIR
//   /app/lib/     dist folders of the browser-lite packages (import map, no bundler)
//
//   ENGINE_DIR=/path/to/engine node server.mjs      (http://localhost:8080/)
// Environment: PORT (8080), HOST (127.0.0.1), PUBLIC_ORIGIN (http://localhost:PORT, the origin
// users open), RELAY_SECRET (at least 32 characters; default random per start),
// RELAY_ALLOW_LOCAL=1 (relay may reach local addresses and all ports: tests only).
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '@browser-lite/server';
import { serveStatic } from '@browser-lite/server/static';
import { authorizeToken, signToken } from '@browser-lite/server/token';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const RELAY_SECRET = process.env.RELAY_SECRET || randomBytes(32).toString('hex');
const ENGINE_DIR = process.env.ENGINE_DIR;
if (!ENGINE_DIR) {
  console.error('Set ENGINE_DIR to the folder with engine.js, engine.wasm and engine.data');
  process.exit(1);
}

// Where npm installed the packages: their dist folders are served as they are
const require = createRequire(import.meta.url);
const distOf = (name) => path.dirname(require.resolve(name));
const LIBS = {
  core: distOf('@browser-lite/core'),
  'transport-wisp': distOf('@browser-lite/transport-wisp'),
  ui: distOf('@browser-lite/ui'),
};
const APP_DIR = path.join(here, 'app');

// Content Security Policy of /app/csp.html: what the engine, the core and the ui need, nothing
// more. The inline import map is allowed by its hash.
async function cspFor(file) {
  const html = await readFile(path.join(APP_DIR, file), 'utf8');
  const hashes = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].map(
    ([, source]) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`,
  );
  return [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`,
    "worker-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "style-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
const CSP = { '/app/csp.html': await cspFor('csp.html') };

// A stand-in for the site's real login: a random session id in a cookie
const sessions = new Map();
function sessionUser(req) {
  const id = /(?:^|;\s*)session=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
  return (id && sessions.get(id)) ?? null;
}

const relay = createRelay({
  path: '/app/wisp/',
  authorize: authorizeToken({ secret: RELAY_SECRET }),
  allowedOrigins: [PUBLIC_ORIGIN],
  policy:
    process.env.RELAY_ALLOW_LOCAL === '1'
      ? { allowPrivateAddresses: true, ports: Array.from({ length: 65535 }, (_, i) => i + 1) }
      : {},
});

function homePage(user) {
  const account = user
    ? `<p>Signed in as ${user}. <a href="/app/">Open the browser</a></p>
<form method="post" action="/logout"><button>Sign out</button></form>`
    : '<form method="post" action="/login"><button>Sign in (demo)</button></form>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Example Site</title></head>
<body style="font: 16px system-ui, sans-serif; max-width: 40rem; margin: 2rem auto">
<h1>Example Site</h1>
<p>The site's own pages, served without special headers. The browser lives under /app/.</p>
${account}
<ul>
<li><a href="/app/">Browser in a section of a page</a></li>
<li><a href="/app/iframe.html">Browser in an iframe</a></li>
<li><a href="/app/csp.html">Browser under a strict Content Security Policy</a></li>
</ul>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;

  // The site's own routes
  if (pathname === '/') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(homePage(sessionUser(req)));
    return;
  }
  if (pathname === '/login' && req.method === 'POST') {
    const id = randomBytes(16).toString('hex');
    sessions.set(id, 'demo-user');
    res
      .writeHead(303, {
        Location: '/app/',
        'Set-Cookie': `session=${id}; Path=/; HttpOnly; SameSite=Strict`,
      })
      .end();
    return;
  }
  if (pathname === '/logout' && req.method === 'POST') {
    const id = /(?:^|;\s*)session=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
    if (id) sessions.delete(id);
    res.writeHead(303, { Location: '/', 'Set-Cookie': 'session=; Path=/; Max-Age=0' }).end();
    return;
  }
  // A relay token for the signed-in user; WispTransport fetches a fresh one for every connect
  if (pathname === '/token') {
    const user = sessionUser(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Sign in first');
      return;
    }
    const token = signToken({ secret: RELAY_SECRET, ttlSeconds: 60, subject: user });
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(token);
    return;
  }

  // browser-lite: everything below /app/ is cross-origin isolated (serveStatic sends the headers)
  if (!pathname.startsWith('/app/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const rest = pathname.slice('/app'.length);
  let found = false;
  if (rest.startsWith('/engine/')) {
    found = await serveStatic(req, res, ENGINE_DIR, { urlPath: rest.slice('/engine'.length) });
  } else if (rest.startsWith('/lib/')) {
    const [, , name = '', ...file] = rest.split('/');
    if (Object.hasOwn(LIBS, name))
      found = await serveStatic(req, res, LIBS[name], { urlPath: `/${file.join('/')}` });
  } else if (rest === '/media-sw.js') {
    found = await serveStatic(req, res, path.join(LIBS.core, 'sw'), { urlPath: rest });
  } else {
    if (CSP[pathname]) res.setHeader('Content-Security-Policy', CSP[pathname]);
    found = await serveStatic(req, res, APP_DIR, { urlPath: rest });
  }
  if (!found) {
    res.removeHeader('Content-Security-Policy');
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  });
});
server.on('upgrade', (req, socket, head) => {
  if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(PORT, HOST, () => console.log(`Listening on http://${HOST}:${PORT}/`));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    relay.close().then(() => server.close(() => process.exit(0)));
  });
