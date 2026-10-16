// Testet Relay (relay/server.mjs, relay/static.mjs) + Wisp-Client (web/transport.js) zusammen:
// Token, Echo mit Flusskontrolle, Gegendruck (onsent), Reconnect nach Neustart des Relays, Verbindungszustand,
// SSRF-Sperre im offenen Betrieb, Auslieferung der Seite (Header, Brotli, ETag/304, kaputte URLs, abgebrochene Downloads).
//   node tests/relay/relay-test.mjs
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
const HOST_BLOCKED = 0x48;

// Nie ewig haengen (z.B. Port belegt, Relay startet nicht)
setTimeout(() => {
  console.log('FAIL Zeitlimit (90 s)');
  process.exit(1);
}, 90000).unref();

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

// Close-Grund eines Streams zu host:port, null wenn er offen bleibt
async function closeReason(transport, host, port) {
  const stream = transport.openTCP(host, port);
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

  const pressure = await backpressure(transport);
  check('Gegendruck: ohne Lesen des Ziels stoppt onsent', pressure.stalled > 0 && pressure.stalled < pressure.total, `${pressure.stalled} von ${pressure.total} Bytes`);
  check('Gegendruck: danach alles gesendet', pressure.sent === pressure.total, `${pressure.sent} Bytes`);

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
    // Namen sperrt die eigene Aufloesung (dns_method), wisp-js meldet das als Verbindungsfehler
    const reason = await closeReason(transport, 'localhost', 80);
    check('localhost gesperrt', reason === 0x03 && relay.log.includes('localhost ist keine oeffentliche Adresse'),
      `Grund ${reason}`);
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

echo.close();
process.exit(failed ? 1 : 0);
