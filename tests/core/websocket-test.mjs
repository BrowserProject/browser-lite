// WebSocket compression like Chrome and Firefox (permessage-deflate, RFC 7692,
// engine/src/websocket/WebSocketPerMessageDeflate.cpp, decision 529): the engine offers it,
// accepts the answers of real servers (the `ws` package, as Node and socket.io servers use it)
// and of hand-written ones (quoted values, parameters, a stream that ends with a final block),
// compresses what the page sends and decompresses what it gets, also fragmented messages and
// with a small window without context takeover. Before patch 0123 every answer with a
// Sec-WebSocket-Extensions header failed the connection ("header is invalid").
//
//   node tests/core/websocket-test.mjs [engine-dir]
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { check, collect, finish, launch, openHost, startStack, timeLimit } from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>WebSocket test</title><body>ws<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + encodeURIComponent(value));
const TEXT = 'browser-lite compresses this line. '.repeat(3000);
const BINARY = new Uint8Array(65536).map((_, i) => i % 251);
const same = (a, b) => a instanceof ArrayBuffer ? new Uint8Array(a).every((v, i) => v === b[i]) && a.byteLength === b.length : a === b;
// Opens path, sends the items, waits for count messages: state, accepted extensions, messages
const session = (path, items, count) => new Promise((resolve) => {
  const socket = new WebSocket('ws://' + location.host + path);
  socket.binaryType = 'arraybuffer';
  const messages = [];
  const done = (state) => {
    clearTimeout(timer);
    resolve({ state, ext: socket.extensions, messages });
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };
  const timer = setTimeout(() => done('timeout'), 20000);
  socket.onopen = () => {
    for (const item of items) socket.send(item);
    if (!count) done('open');
  };
  socket.onmessage = (event) => {
    messages.push(event.data);
    if (messages.length === count) done('open');
  };
  socket.onerror = () => done('error');
});
(async () => {
  const plain = await session('/plain', ['hi'], 1);
  result('plain', [plain.state, plain.ext, ...plain.messages].join('|'));

  const deflate = await session('/deflate', [TEXT, BINARY, TEXT, TEXT], 5);
  const expected = ['fragment one, fragment two', TEXT, BINARY, TEXT, TEXT];
  result('deflate', [deflate.state, deflate.ext, deflate.messages.length === 5 && deflate.messages.every((m, i) => same(m, expected[i]))].join('|'));

  const small = await session('/small-window', [TEXT, TEXT, 'short'], 3);
  result('smallWindow', [small.state, small.ext, small.messages.length === 3 && same(small.messages[0], TEXT) && same(small.messages[1], TEXT) && small.messages[2] === 'short'].join('|'));

  for (const name of ['frame', 'quoted', 'bad', 'final']) {
    const raw = await session('/raw-' + name, [], name === 'quoted' ? 1 : name === 'final' ? 4 : 0);
    result('raw_' + name, [raw.state, raw.ext, ...raw.messages].join('|'));
  }
})();
</script>`;

// The answers of the hand-written server and the messages it sends after the handshake
const deflateRaw = (text, flush) =>
  zlib.deflateRawSync(Buffer.from(text), { finishFlush: flush ?? zlib.constants.Z_SYNC_FLUSH });
const compressed = (text) => deflateRaw(text).subarray(0, -4);
const RAW = {
  '/raw-frame': { extensions: 'x-webkit-deflate-frame', frames: [] },
  '/raw-quoted': {
    extensions: 'permessage-deflate ; server_max_window_bits="10";client_no_context_takeover',
    frames: [compressed('quoted ok')],
  },
  '/raw-bad': { extensions: 'permessage-deflate; foo=1', frames: [] },
  // A stream that ends with a final block (the tail must not start the next one), the empty
  // message as a final block whose end code only the appended tail completes, the empty message
  // without data, then a normal message
  '/raw-final': {
    extensions: 'permessage-deflate',
    frames: [
      deflateRaw('final block', zlib.constants.Z_FINISH),
      Buffer.of(0x03),
      Buffer.alloc(0),
      compressed('after'),
    ],
  },
};
// An unmasked final text frame with RSV1 (compressed)
const textFrame = (payload) => Buffer.concat([Buffer.of(0xc1, payload.length), payload]);

const offers = [];
const wire = {};
const plainServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const deflateServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 0 },
});
const smallServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 0,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    clientMaxWindowBits: 8,
  },
});

const site = http.createServer((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
site.on('upgrade', (req, socket, head) => {
  offers.push(req.headers['sec-websocket-extensions'] ?? '');
  const raw = RAW[req.url];
  if (raw) {
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: ${raw.extensions}\r\n\r\n`,
    );
    for (const payload of raw.frames) socket.write(textFrame(payload));
    socket.on('error', () => {});
    socket.on('data', () => socket.destroy());
    return;
  }
  const server = { '/plain': plainServer, '/deflate': deflateServer, '/small-window': smallServer }[
    req.url
  ];
  if (!server) return socket.destroy();
  server.handleUpgrade(req, socket, head, (ws) => {
    if (req.url === '/deflate') {
      ws.send('fragment one, ', { fin: false });
      ws.send('fragment two', { fin: true });
    }
    let received = 0;
    let sent = 0;
    ws.on('message', (data, binary) => {
      received += data.length;
      sent += data.length;
      ws.send(data, { binary });
      wire[req.url] = { received, sent, read: socket.bytesRead, written: socket.bytesWritten };
    });
  });
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

const stack = await startStack({ token: 'websocket-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(page);
const result = async (key) => decodeURIComponent((await results.wait(key)) ?? 'none');
await openHost(page, stack.app({ url: siteURL }));

const plain = await result('plain');
check('without compression: open, no extension, echo', plain === 'open||hi', plain);
const deflate = await result('deflate');
check(
  'permessage-deflate with a ws server: open, messages both ways and a fragmented one intact',
  deflate === 'open|permessage-deflate|true',
  deflate,
);
const deflateWire = wire['/deflate'] ?? {};
check(
  'what the page sends and gets is compressed on the wire (bytes of 3 x 105 KB text and 64 KB)',
  deflateWire.received > 300000 && deflateWire.read < 20000 && deflateWire.written < 20000,
  JSON.stringify(deflateWire),
);
const small = await result('smallWindow');
check(
  'client window 8, server window 10, no context takeover: messages intact',
  /^open\|permessage-deflate;.*\|true$/.test(small) &&
    small.includes('client_max_window_bits=8') &&
    small.includes('client_no_context_takeover'),
  small,
);
check(
  "the offer is Chrome's",
  offers.length > 0 &&
    offers.every((offer) => offer === 'permessage-deflate; client_max_window_bits'),
  [...new Set(offers)].join(' / '),
);
const frame = await result('raw_frame');
check('an extension the engine did not offer fails the connection', frame === 'error|', frame);
check(
  'the console names it',
  results.logs.some((line) =>
    line.includes('Received unexpected extension: x-webkit-deflate-frame'),
  ),
);
const quoted = await result('raw_quoted');
check(
  'spaces and a quoted value in the answer, then a compressed message',
  /^open\|permessage-deflate; .*\|quoted ok$/.test(quoted) &&
    quoted.includes('server_max_window_bits=10'),
  quoted,
);
const bad = await result('raw_bad');
check('an unknown parameter fails the connection', bad === 'error|', bad);
const final = await result('raw_final');
check(
  'messages that end the stream with a final block (also inside the appended tail)',
  final === 'open|permessage-deflate|final block|||after',
  final,
);

await browser.close();
finish();
