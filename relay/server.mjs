// browser-lite Relay: Wisp-Server (TCP ueber WebSocket) mit Token-Schutz.
//
// Der Browser im Browser schickt hier nur verschluesselte TLS-Bytes durch,
// das Relay sieht keine Inhalte. DNS loest das Relay auf.
//
// Umgebungsvariablen:
//   RELAY_TOKEN    Pflicht. Ohne passenden ?token=... wird die Verbindung abgelehnt.
//   PORT           Standard 5001
//   HOST           Standard 0.0.0.0 (hinter Caddy im Docker-Netz)
//   RELAY_ALLOW_LOCAL=1  Nur fuer Tests: lokale Adressen und alle Ports erlauben
import http from 'node:http';
import crypto from 'node:crypto';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';

const token = process.env.RELAY_TOKEN;
if (!token || token.length < 16) {
  console.error('RELAY_TOKEN fehlt oder ist zu kurz (mindestens 16 Zeichen).');
  process.exit(1);
}
const port = Number(process.env.PORT || 5001);
const host = process.env.HOST || '0.0.0.0';

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
// Caddy setzt X-Forwarded-For
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

const server = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('browser-lite relay\n');
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

server.listen(port, host, () => console.log(`Relay laeuft auf ${host}:${port}`));
