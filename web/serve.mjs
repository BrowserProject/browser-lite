// Kleiner Entwicklungs-Server mit den noetigen Headern fuer SharedArrayBuffer.
//   node web/serve.mjs [port] [engine-ordner]
// Liefert web/ aus und /engine/ aus dem Engine-Build (Standard: build/webcore/bin).
// Mit BL_WEB_ROOT=build/site wird statt web/ die fertige Seite ausgeliefert.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../relay/static.mjs';

const here = process.env.BL_WEB_ROOT ? path.resolve(process.env.BL_WEB_ROOT) : path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);
const engineDir = path.resolve(process.argv[3] || path.join(here, '..', 'build', 'webcore', 'bin'));

createServer((req, res) => {
  const file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const found = file.startsWith('/engine/')
    ? serveStatic(req, res, engineDir, file.slice('/engine'.length), 'no-cache')
    : serveStatic(req, res, here, file, 'no-cache');
  if (!found)
    res.writeHead(404).end('nicht gefunden');
}).listen(port, () => console.log(`browser-lite auf http://localhost:${port}/ (Engine aus ${engineDir})`));
