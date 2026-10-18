// Testet Relay (relay/server.mjs, relay/static.mjs) + Wisp-Client (web/transport.js) zusammen:
// Token, Echo mit Flusskontrolle, Gegendruck (onsent), Reconnect nach Neustart des Relays, Verbindungszustand,
// Gruende fuer gescheiterte Streams, nur TCP, sofort geschlossene Streams, Socket zu nach dem Schliessen, Lebenszeichen des Relays, halb offene Verbindungen, langsamer Upload, SSRF-Sperre im offenen Betrieb, Auslieferung der Seite (Header, Brotli, ETag/304, kaputte URLs, abgebrochene Downloads).
//   node tests/relay/relay-test.mjs
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'test-token-0123456789abcdef';
const TOKEN_PORT = 15001;
const OPEN_PORT = 15002;
const INVALID_INFO = 0x41;
const UNREACHABLE_HOST = 0x42;
const CONNECTION_REFUSED = 0x44;
const ADDRESS_UNREACHABLE = 0x4a; // relay/wisp.mjs
const HOST_BLOCKED = 0x48;
const CONN_THROTTLED = 0x49;
const STREAMS_PER_HOST = 64; // wie relay/server.mjs

// Nie ewig haengen (z.B. Port belegt, Relay startet nicht)
setTimeout(() => {
  console.log('FAIL Zeitlimit (180 s)');
  process.exit(1);
}, 180000).unref();

const children = new Set();
process.on('exit', () => {
  for (const child of children)
    child.kill('SIGKILL');
});

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);
async function waitUntil(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (condition())
      return true;
  }
  return condition();
}

// Startet das Relay. ready: true sobald es laeuft, false wenn es vorher endet.
function startRelay(env) {
  const child = spawn(process.execPath, [path.join(root, 'relay', 'server.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', RELAY_TOKEN: '', RELAY_ALLOW_LOCAL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.log = '';
  child.stderr.on('data', (d) => {
    child.log += d;
    process.stderr.write(d);
  });
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  child.ready = new Promise((resolve) => {
    child.stdout.on('data', (d) => d.toString().includes('laeuft') && resolve(true));
    child.exited.then(() => resolve(false));
  });
  return child;
}

async function stopRelay(child) {
  child.kill('SIGTERM');
  return within(child.exited, 3000, { code: 'haengt' });
}

// Schickt count Bytes ueber einen Wisp-Stream zum Echo-Server und wartet auf die Antwort
async function echoOver(transport, echoPort, total) {
  const stream = transport.openTCP('127.0.0.1', echoPort);
  const chunk = new Uint8Array(Math.min(16384, total)).map((_, i) => i & 0xff);
  let received = 0;
  let corrupt = false;
  const done = new Promise((resolve) => {
    stream.ondata = (data) => {
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== ((received + i) % chunk.length & 0xff)) corrupt = true;
      }
      received += data.length;
      if (received >= total) resolve();
    };
    stream.onclose = resolve;
  });
  stream.onopen = () => {
    for (let sent = 0; sent < total; sent += chunk.length)
      stream.send(chunk);
  };
  await within(done, 20000);
  stream.close();
  return { received, corrupt };
}

// Ziel liest nicht: der Relay gibt keinen Kredit mehr, onsent bleibt unter
// dem, was gesendet wurde. Liest das Ziel wieder, kommt alles an.
async function backpressure(transport) {
  let paused = null;
  const sink = net.createServer((socket) => {
    paused = socket;
    socket.pause();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => sink.on('listening', r));
  const total = 64 * 1024 * 1024;
  const stream = transport.openTCP('127.0.0.1', sink.address().port);
  let sent = 0;
  stream.onsent = (bytes) => sent += bytes;
  stream.onopen = () => {
    const chunk = new Uint8Array(65536);
    for (let queued = 0; queued < total; queued += chunk.length)
      stream.send(chunk);
  };
  await sleep(3000);
  const stalled = sent;
  paused?.resume();
  paused?.on('data', () => {});
  for (let i = 0; i < 300 && sent < total; i++)
    await sleep(100);
  stream.close();
  sink.close();
  return { stalled, sent, total };
}

// Stream, der ein Echo beantwortet (also wirklich verbunden ist), sonst null
async function echoStream(transport, host, port) {
  const stream = transport.openTCP(host, port);
  const answered = await within(new Promise((resolve) => {
    stream.ondata = () => resolve(true);
    stream.onclose = () => resolve(false);
    stream.onopen = () => stream.send(new Uint8Array([1]));
  }), 5000, false);
  return answered ? stream : null;
}

// Close-Grund eines Streams zu host:port, null wenn er offen bleibt
async function closeReason(transport, host, port) {
  const stream = transport.openTCP(host, port);
  return within(new Promise((resolve) => {
    stream.onclose = resolve;
  }), 5000, null);
}

// Wie closeReason, aber CONNECT mit einem anderen Stream-Typ als TCP
async function closeReasonOfType(transport, type, host, port) {
  const stream = transport.openTCP(host, port);
  stream.start = function () {
    const name = new TextEncoder().encode(host);
    const payload = new Uint8Array(3 + name.length);
    payload[0] = type;
    new DataView(payload.buffer).setUint16(1, port, true);
    payload.set(name, 3);
    this.transport.sendPacket(0x01, this.id, payload);
    this.isOpen = true;
  };
  return within(new Promise((resolve) => {
    stream.onclose = resolve;
  }), 5000, null);
}

function request(port, urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Rohe Anfrage: Antwort als Text, und ob der Server die Verbindung schliesst
function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let answer = '';
    socket.on('data', (d) => answer += d);
    socket.on('error', () => {});
    socket.on('close', () => resolve({ answer, closed: true }));
    setTimeout(() => {
      socket.destroy();
      resolve({ answer, closed: false });
    }, 3000);
  });
}

const openFds = (pid) => fs.readdirSync(`/proc/${pid}/fd`).length;

const echo = net.createServer((socket) => socket.pipe(socket)).listen(0, '127.0.0.1');
await new Promise((r) => echo.on('listening', r));
const echoPort = echo.address().port;
const { WispTransport } = await import(path.join(root, 'web', 'transport.js'));

// ---------------------------------------------------------------- mit Token
{
  const env = { RELAY_TOKEN: TOKEN, PORT: String(TOKEN_PORT), RELAY_ALLOW_LOCAL: '1' };
  let relay = startRelay(env);
  check('Relay mit Token startet', await relay.ready);

  const bad = new WispTransport(`ws://127.0.0.1:${TOKEN_PORT}/wisp/?token=falsch`);
  check('falscher Token abgelehnt', await bad.connect().then(() => false, () => true));
  const none = new WispTransport(`ws://127.0.0.1:${TOKEN_PORT}/wisp/`);
  check('fehlender Token abgelehnt', await none.connect().then(() => false, () => true));

  const transport = new WispTransport(`ws://127.0.0.1:${TOKEN_PORT}/wisp/?token=${TOKEN}`);
  const big = await echoOver(transport, echoPort, 2 * 1024 * 1024);
  check('2 MB Echo', big.received === 2 * 1024 * 1024 && !big.corrupt, `${big.received} Bytes, korrupt=${big.corrupt}`);

  // Gescheiterte Streams mit Grund (Fehlerseite der Engine): abgewiesen, Name unbekannt,
  // leeres Ziel (die Nachfrage des Transports, ob die Verbindung lebt)
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  check('Port zu: Grund abgewiesen', await closeReason(transport, '127.0.0.1', closedPort) === CONNECTION_REFUSED);
  check('Unbekannter Name: Grund Host nicht erreichbar', await closeReason(transport, 'nonexistent.invalid', 80) === UNREACHABLE_HOST);
  check('Leeres Ziel: Grund ungueltig', await closeReason(transport, '', 0) === INVALID_INFO);
  // Adresse ohne Weg dorthin (Dokumentationsnetz), nur wenn dieser Rechner das auch so sieht
  const unreachable = await new Promise((resolve) => {
    const socket = net.connect({ host: '2001:db8::1', port: 80 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.on('error', (error) => done(['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)));
    socket.on('connect', () => done(false));
    setTimeout(() => done(false), 3000).unref();
  });
  if (unreachable)
    check('Adresse nicht erreichbar: eigener Grund', await closeReason(transport, '2001:db8::1', 80) === ADDRESS_UNREACHABLE);
  else
    console.log('Hinweis: 2001:db8::1 ist hier nicht sofort unerreichbar, Fall uebersprungen');

  // Schliesst der Client einen Stream gleich nach CONNECT (noch beim Aufloesen des Namens),
  // verbindet das Relay danach nicht mehr: sonst hielte es Verbindungen ausserhalb jeder Grenze
  {
    let accepted = 0;
    const target = net.createServer((socket) => {
      accepted++;
      socket.destroy();
    }).listen(0);
    await new Promise((r) => target.on('listening', r));
    for (let i = 0; i < 20; i++) {
      const stream = transport.openTCP('localhost', target.address().port);
      stream.onopen = () => stream.close();
    }
    await sleep(1500);
    check('Sofort geschlossene Streams verbinden nicht', accepted === 0, `${accepted} Verbindungen`);
    target.close();
  }

  // Grenze pro Ziel (Name und Port): weitere Streams dorthin enden mit "gedrosselt", auch
  // anders geschrieben; ein anderer Name, ein anderer Port und ein frei gewordener Platz gehen
  const held = await Promise.all(Array.from({ length: STREAMS_PER_HOST }, () => echoStream(transport, '127.0.0.1', echoPort)));
  check(`${STREAMS_PER_HOST} Streams zum gleichen Ziel`, held.every(Boolean), `${held.filter(Boolean).length} verbunden`);
  check('Ein Stream mehr: Grund gedrosselt', await closeReason(transport, '127.0.0.1', echoPort) === CONN_THROTTLED);
  check('Mit Punkt am Ende: auch gedrosselt', await closeReason(transport, '127.0.0.1.', echoPort) === CONN_THROTTLED);
  check('Anderer Port: nicht gedrosselt', await closeReason(transport, '127.0.0.1', closedPort) === CONNECTION_REFUSED);
  // "127.1" ist ein anderer Name, den getaddrinfo auch zu 127.0.0.1 aufloest
  const other = await echoStream(transport, '127.1', echoPort);
  check('Anderes Ziel geht trotzdem', Boolean(other));
  held.pop()?.close();
  const freed = await echoStream(transport, '127.0.0.1', echoPort);
  check('Nach dem Schliessen eines Streams wieder Platz', Boolean(freed));
  for (const stream of [...held, other, freed])
    stream?.close();

  // Ein Name mit IPv6 zuerst (localhost: ::1), das Ziel hoert nur auf IPv4: das Relay
  // versucht alle gepruften Adressen wie ein Browser (Server ohne IPv6, z.B. CI)
  const dualStack = await echoStream(transport, 'localhost', echoPort);
  check('Name mit IPv6 zuerst, Ziel nur auf IPv4', Boolean(dualStack));
  dualStack?.close();

  const pressure = await backpressure(transport);
  check('Gegendruck: ohne Lesen des Ziels stoppt onsent', pressure.stalled > 0 && pressure.stalled < pressure.total, `${pressure.stalled} von ${pressure.total} Bytes`);
  check('Gegendruck: danach alles gesendet', pressure.sent === pressure.total, `${pressure.sent} Bytes`);

  // Nur TCP: jeder andere Typ ginge an der Pruefung der Adresse vorbei (hier waere
  // Loopback sogar erlaubt)
  {
    const udp = dgram.createSocket('udp4');
    let datagrams = 0;
    udp.on('message', () => datagrams++);
    await new Promise((r) => udp.bind(0, '127.0.0.1', r));
    const reasons = [];
    for (const type of [0x02, 0x03, 0xff])
      reasons.push(await closeReasonOfType(transport, type, '127.0.0.1', udp.address().port));
    await sleep(300);
    check('Andere Stream-Typen als TCP gesperrt', reasons.every((reason) => reason === HOST_BLOCKED) && datagrams === 0, `Gruende ${reasons}, ${datagrams} Datagramme`);
    udp.close();
  }

  // Schliesst der Client einen Stream, ist auch der Socket zum Ziel zu, selbst wenn das Ziel
  // weiter sendet: sonst hielte er Verbindungen ausserhalb jeder Grenze und pufferte ohne Ende
  {
    let targetClosed = false;
    const target = net.createServer({ allowHalfOpen: true }, (socket) => {
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (!socket.destroyed && socket.write(chunk));
      };
      socket.on('drain', pump);
      socket.on('error', () => {});
      socket.on('close', () => {
        targetClosed = true;
      });
      pump();
    }).listen(0, '127.0.0.1');
    await new Promise((r) => target.on('listening', r));
    const stream = transport.openTCP('127.0.0.1', target.address().port);
    await within(new Promise((resolve) => {
      stream.ondata = resolve;
    }), 5000);
    stream.close();
    check('Geschlossener Stream: Socket zum Ziel zu, obwohl es weiter sendet', await waitUntil(() => targetClosed, 3000));
    target.close();
  }

  // Offene Streams ohne Verkehr: das Relay meldet sich trotzdem regelmaessig
  {
    const silent = net.createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((r) => silent.on('listening', r));
    const stream = await new Promise((resolve) => {
      const opened = transport.openTCP('127.0.0.1', silent.address().port);
      opened.onopen = () => resolve(opened);
    });
    await sleep(500);
    const before = transport.received;
    await sleep(4000);
    check('Stiller Stream: Relay meldet sich', transport.received > before, `${transport.received - before} Pakete`);
    stream.close();
    silent.close();
  }

  const stopped = await stopRelay(relay);
  check('SIGTERM beendet das Relay sauber', stopped.code === 0, JSON.stringify(stopped));

  relay = startRelay(env);
  await relay.ready;
  const again = await echoOver(transport, echoPort, 64 * 1024);
  check('gleicher Transport nach Neustart des Relays', again.received === 64 * 1024 && !again.corrupt, `${again.received} Bytes`);

  // Verbindungszustand (navigator.onLine der Seiten): weg beim Stopp, danach
  // von selber wieder da, ohne neuen Stream
  const states = [];
  transport.onconnectedchange = (connected) => states.push(connected);
  // Schliesst nur die WebSocket (wie ein Proxy im Leerlauf), bleibt es online
  const closedSocket = transport.ws;
  closedSocket.close();
  const replaced = await waitUntil(() => transport.connected && transport.ws !== closedSocket && transport.ws.readyState === 1, 3000);
  check('WebSocket zu, Relay da: sofort neu verbunden, nie offline', replaced && states.length === 0, states.join());
  await stopRelay(relay);
  const down = await waitUntil(() => !transport.connected, 3000);
  relay = startRelay(env);
  await relay.ready;
  const up = await waitUntil(() => transport.connected, 8000);
  check('Verbindung weg und von selber wieder da', down && up && states.join() === 'false,true', states.join());
  transport.onconnectedchange = null;
  transport.ws?.close();
  await stopRelay(relay);
}

// ---------------------------------------------------------------- Token zu kurz
{
  const relay = startRelay({ RELAY_TOKEN: 'kurz', PORT: String(OPEN_PORT) });
  const ready = await relay.ready;
  const { code } = await relay.exited;
  check('zu kurzer Token beendet mit 1', !ready && code === 1, `code=${code}`);
}

// ---------------------------------------------------------------- offen, mit Seite
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-relay-test-'));
try {
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html>hallo');
  fs.writeFileSync(path.join(site, 'a.js'), 'console.log("a");'.repeat(100));
  fs.writeFileSync(path.join(site, 'a.js.br'), 'brotli');
  // Gross genug, dass ein Download nicht sofort im Socket-Puffer verschwindet
  fs.mkdirSync(path.join(site, 'engine'));
  fs.writeFileSync(path.join(site, 'engine', 'big.wasm'), '');
  fs.truncateSync(path.join(site, 'engine', 'big.wasm'), 64 * 1024 * 1024);

  const relay = startRelay({ PORT: String(OPEN_PORT), SITE_DIR: site });
  check('offenes Relay mit Seite startet', await relay.ready);

  const transport = new WispTransport(`ws://127.0.0.1:${OPEN_PORT}/wisp/`);
  check('ohne Token verbunden', await transport.connect().then(() => true, () => false));

  // Ports 80/443, damit nur die Adresse geprueft wird. Verbunden wird nie, also ohne Netz.
  for (const host of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::1', '0.0.0.0', '10.0.0.1',
    '192.168.1.1', '172.17.0.1', '169.254.169.254', '100.64.0.1', 'fd00::1', 'fe80::1', '64:ff9b::7f00:1']) {
    const reason = await closeReason(transport, host, 443);
    check(`${host} gesperrt`, reason === HOST_BLOCKED, `Grund ${reason}`);
  }
  {
    const reason = await closeReason(transport, '1.1.1.1', 22);
    check('Port 22 gesperrt', reason === HOST_BLOCKED, `Grund ${reason}`);
  }
  {
    const reason = await closeReason(transport, 'localhost', 80);
    check('localhost gesperrt', reason === HOST_BLOCKED, `Grund ${reason}`);
  }
  {
    // Die Nachfrage des Transports kommt auch an der Port-Sperre vorbei und fuellt kein Log
    const reason = await closeReason(transport, '', 0);
    check('Leeres Ziel: Grund ungueltig, ohne Warnung', reason === INVALID_INFO && !relay.log.includes('stream to :0'), `Grund ${reason}`);
  }
  transport.ws?.close();

  const health = await request(OPEN_PORT, '/healthz');
  check('/healthz', health.status === 200 && health.body.toString() === 'ok\n');

  const index = await request(OPEN_PORT, '/');
  check('/ mit COOP/COEP', index.status === 200
    && index.headers['cross-origin-opener-policy'] === 'same-origin'
    && index.headers['cross-origin-embedder-policy'] === 'require-corp'
    && index.headers['cache-control'] === 'no-cache');
  check('/ mit ETag und Last-Modified', Boolean(index.headers.etag && index.headers['last-modified']), index.headers.etag);

  const cached = await request(OPEN_PORT, '/', { headers: { 'If-None-Match': `"x", ${index.headers.etag}` } });
  check('If-None-Match ergibt 304 ohne Body', cached.status === 304 && cached.body.length === 0
    && cached.headers.etag === index.headers.etag && cached.headers['cache-control'] === 'no-cache');
  const changed = await request(OPEN_PORT, '/', { headers: { 'If-None-Match': '"anders"' } });
  check('anderer ETag ergibt 200', changed.status === 200);

  const plain = await request(OPEN_PORT, '/a.js');
  const br = await request(OPEN_PORT, '/a.js', { headers: { 'Accept-Encoding': 'gzip, br' } });
  check('Brotli wenn moeglich', br.headers['content-encoding'] === 'br' && br.body.toString() === 'brotli'
    && br.headers.vary === 'Accept-Encoding' && plain.headers['content-encoding'] === undefined);
  check('ETag je Kodierung', plain.headers.etag !== br.headers.etag);

  const head = await request(OPEN_PORT, '/a.js', { method: 'HEAD' });
  check('HEAD ohne Body', head.status === 200 && head.body.length === 0
    && head.headers['content-length'] === String(plain.body.length));

  const engine = await request(OPEN_PORT, '/engine/big.wasm', { method: 'HEAD' });
  check('Engine-Dateien unveraenderlich', engine.headers['cache-control'].includes('immutable')
    && engine.headers['content-type'] === 'application/wasm');

  for (const bad of ['/..%2f..%2fetc%2fpasswd', '/../../etc/passwd', '/fehlt.js'])
    check(`${bad} ist 404`, (await request(OPEN_PORT, bad)).status === 404);
  for (const bad of ['/%zz', '/%E0'])
    check(`${bad} ist 400`, (await request(OPEN_PORT, bad)).status === 400);

  const upgrade = await rawRequest(OPEN_PORT, 'GET //[x HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
    + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  check('Upgrade mit kaputter URL: 400 und geschlossen', upgrade.answer.startsWith('HTTP/1.1 400') && upgrade.closed,
    JSON.stringify(upgrade.answer.split('\r\n')[0]));

  if (fs.existsSync(`/proc/${relay.pid}/fd`)) {
    const before = openFds(relay.pid);
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: OPEN_PORT, path: '/engine/big.wasm', agent: false }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', resolve);
      });
    }
    await sleep(500);
    const after = openFds(relay.pid);
    check('abgebrochene Downloads schliessen ihre Dateien', after <= before + 2, `fds ${before} -> ${after}`);
  }
  check('Relay laeuft danach weiter', (await request(OPEN_PORT, '/healthz')).status === 200);

  await stopRelay(relay);
} finally {
  fs.rmSync(site, { recursive: true, force: true });
}

// ---------------------------------------------------------------- halb offene Verbindung
// Ein "Relay", das nach dem Handshake nichts mehr sagt (wie nach dem Ruhezustand): der
// Transport fragt nach, bekommt keine Antwort, schliesst die Streams mit 0x03 und verbindet
// neu. Beantwortet es die Nachfrage (wie ein Long-Poll, der lange keine Daten hat), bleibt
// der Stream offen.
{
  const { WebSocketServer } = await import('ws');
  let answerProbes = true;
  let connections = 0;
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => silent.on('listening', r));
  silent.on('connection', (ws) => {
    connections++;
    ws.send(Uint8Array.of(0x03, 0, 0, 0, 0, 128, 0, 0, 0));
    ws.on('message', (data) => {
      const packet = new Uint8Array(data);
      // CONNECT auf Port 0 ist die Nachfrage
      if (answerProbes && packet[0] === 0x01 && packet[6] === 0 && packet[7] === 0)
        ws.send(Uint8Array.of(0x04, ...packet.subarray(1, 5), INVALID_INFO));
    });
  });
  const transport = new WispTransport(`ws://127.0.0.1:${silent.address().port}/`);
  const waitForAnswer = async (ms) => {
    const stream = transport.openTCP('example.org', 80);
    stream.onopen = () => stream.send(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'));
    const started = Date.now();
    const reason = await within(new Promise((resolve) => {
      stream.onclose = resolve;
    }), ms, null);
    stream.close();
    return { reason, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  };
  const alive = await waitForAnswer(18000);
  check('Nachfrage beantwortet: Stream bleibt offen', alive.reason === null && connections === 1, JSON.stringify(alive));
  answerProbes = false;
  const dead = await waitForAnswer(25000);
  check('Keine Antwort: Stream endet mit Netzwerkfehler', dead.reason === 0x03, JSON.stringify(dead));
  const again = transport.openTCP('example.org', 80);
  await waitUntil(() => connections === 2, 3000);
  check('danach neue Verbindung', connections === 2, `${connections} Verbindungen`);
  again.close();
  transport.ws?.close();
  silent.close();
}

// ---------------------------------------------------------------- langsamer Upload
// Eine WebSocket ueber eine langsame Leitung zu einem Relay, das lebt: es beantwortet die
// Nachfrage, sobald sie ankommt, und sagt sonst nichts. Der Upload dauert laenger, als der
// Transport auf eine Antwort wartet: er darf die Verbindung trotzdem nicht aufgeben. Steht
// die Leitung (Rate 0, der Puffer leert sich nie), ist sie tot. Liegt der Upload ausserhalb der
// WebSocket (Puffer des Betriebssystems, bufferedAmount 0), haelt das Lebenszeichen des Relays
// (CONTINUE auf Stream 0, relay/wisp.mjs) die Verbindung.
{
  class SlowLink {
    static OPEN = 1;
    constructor(url) {
      const params = new URL(url).searchParams;
      this.rate = Number(params.get('rate'));
      this.hidden = params.has('versteckt');
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.queue = [];
      this.offset = 0; // vom ersten Paket schon uebertragen
      this.uploaded = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.deliver(Uint8Array.of(0x03, 0, 0, 0, 0, 128, 0, 0, 0));
      }, 10);
      this.timer = setInterval(() => this.transfer(this.rate / 10), 100);
      if (this.hidden)
        this.keepalive = setInterval(() => this.deliver(Uint8Array.of(0x03, 0, 0, 0, 0, 128, 0, 0, 0)), 3000);
    }
    deliver(packet) {
      this.onmessage?.({ data: packet.buffer });
    }
    send(packet) {
      this.queue.push(packet);
      if (!this.hidden)
        this.bufferedAmount += packet.byteLength;
    }
    transfer(budget) {
      while (budget > 0 && this.queue.length) {
        const packet = this.queue[0];
        const part = Math.min(budget, packet.byteLength - this.offset);
        budget -= part;
        this.offset += part;
        if (!this.hidden)
          this.bufferedAmount -= part;
        if (this.offset < packet.byteLength)
          break;
        this.queue.shift();
        this.offset = 0;
        if (packet[0] === 0x02)
          this.uploaded += packet.byteLength - 5;
        if (packet[0] === 0x01 && packet[6] === 0 && packet[7] === 0)
          this.deliver(Uint8Array.of(0x04, ...packet.subarray(1, 5), INVALID_INFO));
      }
    }
    close() {
      clearInterval(this.timer);
      clearInterval(this.keepalive);
      this.readyState = 3;
      this.onclose?.();
    }
  }
  // Eigene Kopie des Transports, die SlowLink fuer ihre WebSocket nimmt
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SlowLink;
  const { WispTransport: SlowTransport } = await import(path.join(root, 'web', 'transport.js') + '?langsam');
  globalThis.WebSocket = NativeWebSocket;

  const PACKET = 32 * 1024;
  const upload = async (rate, packets, ms, hidden = false) => {
    const transport = new SlowTransport(`ws://langsam/?rate=${rate}${hidden ? '&versteckt' : ''}`);
    const stream = transport.openTCP('example.org', 80);
    stream.onopen = () => {
      for (let i = 0; i < packets; i++)
        stream.send(new Uint8Array(PACKET));
    };
    const reason = await within(new Promise((resolve) => {
      stream.onclose = resolve;
    }), ms, null);
    const uploaded = transport.ws.uploaded;
    stream.close();
    transport.ws.close();
    return { reason, uploaded };
  };
  // 1.8 MB mit 100 KB/s: die Nachfrage nach 10 s kaeme erst nach 18 s an
  const [slow, hidden, stalled] = await Promise.all([upload(100 * 1024, 56, 23000), upload(100 * 1024, 56, 23000, true), upload(0, 4, 15000)]);
  check('Langsamer Upload: Verbindung bleibt, alles angekommen', slow.reason === null && slow.uploaded === 56 * PACKET, JSON.stringify(slow));
  check('Upload im Puffer des Betriebssystems: Lebenszeichen haelt die Verbindung', hidden.reason === null && hidden.uploaded === 56 * PACKET, JSON.stringify(hidden));
  check('Leitung steht: Stream endet mit Netzwerkfehler', stalled.reason === 0x03, JSON.stringify(stalled));
}

echo.close();
process.exit(failed ? 1 : 0);
