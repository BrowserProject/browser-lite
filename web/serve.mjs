// Kleiner Entwicklungs-Server mit den noetigen Headern fuer SharedArrayBuffer.
//   node web/serve.mjs [port] [engine-ordner]
// Liefert web/ aus und /engine/ aus dem Engine-Build (Standard: build/webcore/bin).
// Mit BL_WEB_ROOT=build/site wird statt web/ die fertige Seite ausgeliefert.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = process.env.BL_WEB_ROOT ? path.resolve(process.env.BL_WEB_ROOT) : path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);
const engineDir = path.resolve(process.argv[3] || path.join(here, '..', 'build', 'webcore', 'bin'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.json': 'application/json' };

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = decodeURIComponent(url.pathname);
  if (file.endsWith('/'))
    file += 'index.html';
  const base = file.startsWith('/engine/') ? engineDir : here;
  if (file.startsWith('/engine/'))
    file = file.slice('/engine'.length);
  const full = path.join(base, path.normalize(file));
  if (!full.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  let stat;
  try {
    stat = statSync(full);
  } catch {
    res.writeHead(404).end('nicht gefunden');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(full)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  });
  createReadStream(full).pipe(res);
}).listen(port, () => console.log(`browser-lite auf http://localhost:${port}/ (Engine aus ${engineDir})`));
