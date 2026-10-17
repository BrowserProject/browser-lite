// browser-lite Server: Wisp-Relay (TCP ueber WebSocket), optional mit Token, und mit
// SITE_DIR, die fertige Seite (tools/package-site.sh). Laeuft so im Container (Dockerfile).
//
// Der Browser im Browser schickt hier nur verschluesselte TLS-Bytes durch,
// das Relay sieht keine Inhalte. DNS loest das Relay auf.
//
// Umgebungsvariablen:
//   RELAY_TOKEN    Optional. Gesetzt wird ohne passenden ?token=... jede Verbindung abgelehnt,
//                  ohne ist das Relay offen (nur fuer interne Server).
//   PORT           Standard 5001
//   HOST           Standard 0.0.0.0
//   SITE_DIR       Ordner der fertigen Seite. Ohne nur Relay.
//   RELAY_ALLOW_LOCAL=1  Nur fuer Tests: lokale Adressen und alle Ports erlauben
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import ipaddr from 'ipaddr.js';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { parseRequest, serveStatic } from './static.mjs';
import { createWispHandler } from './wisp.mjs';

const token = process.env.RELAY_TOKEN;
if (token && token.length < 16) {
  console.error('RELAY_TOKEN ist zu kurz (mindestens 16 Zeichen).');
  process.exit(1);
}
if (!token)
  console.warn('Ohne RELAY_TOKEN: das Relay ist fuer alle offen, nur intern betreiben.');
const port = Number(process.env.PORT || 5001);
const host = process.env.HOST || '0.0.0.0';
const siteDir = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : null;

// UDP braucht erst WireGuard (spaeter), bis dahin aus
wisp.options.allow_udp_streams = false;
// Begrenzungen gegen Missbrauch: Streams pro Verbindung, davon pro Ziel (wisp.mjs)
wisp.options.stream_limit_total = 256;
const STREAMS_PER_HOST = 64;
logging.set_level(logging.WARN);

let allowAddress = () => true;
if (process.env.RELAY_ALLOW_LOCAL === '1') {
  console.warn('ACHTUNG: RELAY_ALLOW_LOCAL=1, nur fuer Tests verwenden!');
  wisp.options.allow_private_ips = true;
  wisp.options.allow_loopback_ips = true;
} else {
  // Kein Zugriff auf das eigene Netz des Servers (SSRF-Schutz), nur Web-Ports.
  // Die Pruefung von wisp-js kennt ::ffff:127.0.0.1, fd00::/8 usw. nicht, darum zusaetzlich
  // eine eigene: nur oeffentliche Adressen. IP-Literale prueft schon die Blacklist, jede
  // Adresse, mit der das Relay wirklich verbindet, prueft der Socket (wisp.mjs, nur TCP).
  const isPublic = (address) => ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
  allowAddress = isPublic;
  wisp.options.allow_private_ips = false;
  wisp.options.allow_loopback_ips = false;
  wisp.options.port_whitelist = [80, 443, 8080, 8443];
  wisp.options.hostname_blacklist = [{ test: (name) => net.isIP(name) !== 0 && !isPublic(name) }];
}
const handleWisp = createWispHandler({ allowAddress, streamsPerHost: STREAMS_PER_HOST });

// Ein Fehler in einer einzelnen Verbindung darf nie das ganze Relay beenden
process.on('uncaughtException', (error) => console.error('Fehler (Relay laeuft weiter):', error));
process.on('unhandledRejection', (error) => console.error('Fehler (Relay laeuft weiter):', error));
// Als PID 1 im Container beendet SIGTERM Node nur mit Handler. Zu sichern gibt es nichts.
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => process.exit(0));

function tokenOK(given) {
  if (!token)
    return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Engine-Dateien liegen in engine/<version>/ und aendern sich nie mehr
function cacheControl(urlPath) {
  return urlPath.startsWith('/engine/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

const server = http.createServer((req, res) => {
  const request = parseRequest(req);
  if (!request) {
    res.writeHead(400).end();
    return;
  }
  if (request.path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
    return;
  }
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (siteDir && isRead && serveStatic(req, res, siteDir, request.path, cacheControl(request.path)))
    return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('browser-lite\n');
});

function refuse(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const request = parseRequest(req);
  if (!request) {
    refuse(socket, '400 Bad Request');
    return;
  }
  if (!request.path.startsWith('/wisp/') || !tokenOK(request.url.searchParams.get('token'))) {
    refuse(socket, '403 Forbidden');
    return;
  }
  handleWisp(req, socket, head);
});

// Ohne Port (z.B. belegt) nicht still mit Code 0 enden
const failToStart = (error) => {
  console.error('Relay startet nicht:', error.message);
  process.exit(1);
};
server.once('error', failToStart);
server.listen(port, host, () => {
  server.off('error', failToStart);
  console.log(`Relay laeuft auf ${host}:${port}${siteDir ? `, Seite aus ${siteDir}` : ''}`);
});
