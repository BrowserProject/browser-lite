// Testet Relay (relay/server.mjs) + Wisp-Client (web/transport.js) zusammen:
// TCP-Echo-Server lokal, Daten hin und zurueck, Flusskontrolle, Token-Pruefung.
//   node tests/relay/relay-test.mjs
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'test-token-0123456789abcdef';
const RELAY_PORT = 15001;

const echo = net.createServer((socket) => socket.pipe(socket)).listen(0, '127.0.0.1');
await new Promise((r) => echo.on('listening', r));
const echoPort = echo.address().port;

const relay = spawn(process.execPath, [path.join(root, 'relay', 'server.mjs')], {
  env: { ...process.env, RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => relay.stdout.on('data', (d) => d.toString().includes('laeuft') && resolve()));

const { WispTransport } = await import(path.join(root, 'web', 'transport.js'));
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
};

// 1) Falscher Token wird abgelehnt
{
  const bad = new WispTransport(`ws://127.0.0.1:${RELAY_PORT}/wisp/?token=falsch`);
  const result = await bad.connect().then(() => 'verbunden', () => 'abgelehnt');
  check('falscher Token abgelehnt', result === 'abgelehnt');
}

// 2) Echo ueber Wisp, 2 MB (testet auch die Flusskontrolle)
{
  const transport = new WispTransport(`ws://127.0.0.1:${RELAY_PORT}/wisp/?token=${TOKEN}`);
  const stream = transport.openTCP('127.0.0.1', echoPort);
  const total = 2 * 1024 * 1024;
  const chunk = new Uint8Array(16384).map((_, i) => i & 0xff);
  let received = 0;
  let corrupt = false;
  const done = new Promise((resolve) => {
    stream.ondata = (data) => {
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== ((received + i) % 16384 & 0xff)) corrupt = true;
      }
      received += data.length;
      if (received >= total) resolve();
    };
  });
  stream.onopen = () => {
    for (let sent = 0; sent < total; sent += chunk.length)
      stream.send(chunk);
  };
  await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  check('2 MB Echo', received === total && !corrupt, `${received} Bytes, korrupt=${corrupt}`);
  stream.close();
  transport.ws.close();
}

relay.kill();
echo.close();
process.exit(failed ? 1 : 0);
