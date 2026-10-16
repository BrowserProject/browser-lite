// browser-lite Server: Wisp-Relay (TCP ueber WebSocket) mit Token-Schutz und, mit
// SITE_DIR, die fertige Seite (tools/package-site.sh). Laeuft so im Container (Dockerfile).
//
// Der Browser im Browser schickt hier nur verschluesselte TLS-Bytes durch,
// das Relay sieht keine Inhalte. DNS loest das Relay auf.
//
// Umgebungsvariablen:
//   RELAY_TOKEN    Pflicht. Ohne passenden ?token=... wird die Verbindung abgelehnt.
//   PORT           Standard 5001
//   HOST           Standard 0.0.0.0
//   SITE_DIR       Ordner der fertigen Seite. Ohne nur Relay.
//   RELAY_ALLOW_LOCAL=1  Nur fuer Tests: lokale Adressen und alle Ports erlauben
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { serveStatic } from './static.mjs';

const token = process.env.RELAY_TOKEN;
if (!token || token.length < 16) {
  console.error('RELAY_TOKEN fehlt oder ist zu kurz (mindestens 16 Zeichen).');
  process.exit(1);
}
const port = Number(process.env.PORT || 5001);
const host = process.env.HOST || '0.0.0.0';
const siteDir = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : null;

// Kein Zugriff auf das eigene Netz des Servers (SSRF-Schutz)
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
// UDP braucht erst WireGuard (spaeter), bis dahin aus
wisp.options.allow_udp_streams = false;
// Nur Web-Ports
wisp.options.port_whitelist = [80, 443, 8080, 8443];
// Begrenzungen gegen Missbrauch. (stream_limit_per_host ist in wisp-js 0.4.1
// kaputt: "connection.streams is not iterable", darum nur das Gesamtlimit.)
wisp.options.stream_limit_total = 256;
// Reverse-Proxy davor (lokal oder im Docker-Netz) setzt X-Forwarded-For
wisp.options.parse_real_ip_from = ['127.0.0.1', '::ffff:127.0.0.1', '172.16.0.0/12'];
logging.set_level(logging.WARN);

if (process.env.RELAY_ALLOW_LOCAL === '1') {
  console.warn('ACHTUNG: RELAY_ALLOW_LOCAL=1, nur fuer Tests verwenden!');
  wisp.options.allow_private_ips = true;
  wisp.options.allow_loopback_ips = true;
  wisp.options.port_whitelist = null;
}

// Ein Fehler in einer einzelnen Verbindung darf nie das ganze Relay beenden
process.on('uncaughtException', (error) => console.error('Fehler (Relay laeuft weiter):', error));
process.on('unhandledRejection', (error) => console.error('Fehler (Relay laeuft weiter):', error));

function tokenOK(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Engine-Dateien liegen in engine/<version>/ und aendern sich nie mehr
function cacheControl(urlPath) {
  return urlPath.startsWith('/engine/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://relay').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
    return;
  }
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (siteDir && isRead && serveStatic(req, res, siteDir, urlPath, cacheControl(urlPath)))
    return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('browser-lite\n');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  if (!url.pathname.startsWith('/wisp/') || !tokenOK(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // wisp-js erkennt Wisp nur an einem Pfad, der auf "/" endet: Token entfernen
  req.url = '/wisp/';
  wisp.routeRequest(req, socket, head);
});

server.listen(port, host, () => console.log(`Relay laeuft auf ${host}:${port}${siteDir ? `, Seite aus ${siteDir}` : ''}`));
