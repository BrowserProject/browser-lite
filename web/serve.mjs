// Small development server with the headers needed for SharedArrayBuffer.
//   npm run build && node web/serve.mjs [port] [engine-dir]
// Serves web/ and /engine/ from the engine build (default: build/webcore/bin). With
// BL_WEB_ROOT=build/site the built site is served instead of web/, with PROFILE_DIR the browser
// profile answers under /profile/ (without token; names besides IP addresses and localhost with
// PROFILE_HOSTS, comma separated, like browser-lite-server).
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from '@browser-lite/server';
import { serveStatic } from '@browser-lite/server/static';

const here = process.env.BL_WEB_ROOT ? path.resolve(process.env.BL_WEB_ROOT) : path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);
const engineDir = path.resolve(process.argv[3] || path.join(here, '..', 'build', 'webcore', 'bin'));
const profile = process.env.PROFILE_DIR
  ? createProfileStore({ dir: path.resolve(process.env.PROFILE_DIR), hosts: (process.env.PROFILE_HOSTS || '').split(',') })
  : null;

async function respond(req, res) {
  if (profile && await profile.handle(req, res))
    return;
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const found = urlPath.startsWith('/engine/')
    ? await serveStatic(req, res, engineDir, { urlPath: decodeURIComponent(urlPath.slice('/engine'.length)) })
    : await serveStatic(req, res, here);
  if (!found)
    res.writeHead(404).end('not found');
}

createServer((req, res) => {
  respond(req, res).catch(() => {
    if (!res.headersSent)
      res.writeHead(400).end();
    else
      res.destroy();
  });
}).listen(port, () => console.log(`browser-lite dev server listening on http://localhost:${port}/ (engine from ${engineDir})`));
