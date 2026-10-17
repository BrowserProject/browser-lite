// Kleiner Entwicklungs-Server mit den noetigen Headern fuer SharedArrayBuffer.
//   node web/serve.mjs [port] [engine-ordner]
// Liefert web/ aus und /engine/ aus dem Engine-Build (Standard: build/webcore/bin).
// Mit BL_WEB_ROOT=build/site wird statt web/ die fertige Seite ausgeliefert, mit PROFILE_DIR
// gibt es das Browser-Profil unter /profile/ (relay/profile.mjs, ohne Token, weitere Namen
// ausser IP-Adressen und localhost mit PROFILE_HOSTS wie in relay/server.mjs).
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileHandler } from '../relay/profile.mjs';
import { parseRequest, serveStatic } from '../relay/static.mjs';

const here = process.env.BL_WEB_ROOT ? path.resolve(process.env.BL_WEB_ROOT) : path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);
const engineDir = path.resolve(process.argv[3] || path.join(here, '..', 'build', 'webcore', 'bin'));
const handleProfile = process.env.PROFILE_DIR ? createProfileHandler({ dir: path.resolve(process.env.PROFILE_DIR), hosts: process.env.PROFILE_HOSTS }) : () => false;

createServer((req, res) => {
  const request = parseRequest(req);
  if (!request) {
    res.writeHead(400).end();
    return;
  }
  if (handleProfile(req, res, request))
    return;
  const file = request.path;
  const found = file.startsWith('/engine/')
    ? serveStatic(req, res, engineDir, file.slice('/engine'.length), 'no-cache')
    : serveStatic(req, res, here, file, 'no-cache');
  if (!found)
    res.writeHead(404).end('nicht gefunden');
}).listen(port, () => console.log(`browser-lite auf http://localhost:${port}/ (Engine aus ${engineDir})`));
