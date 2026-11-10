// An HTTP/2 server with a low MAX_CONCURRENT_STREAMS (www.postfinance.ch announces 10): the engine
// never opens more streams on a connection than the server allows. The limit comes with the
// server's SETTINGS, and before them curl assumed 100: a new connection took every waiting request
// at once, and the server reset the streams over its limit. Envoy does that with
// FLOW_CONTROL_ERROR, which no browser retries, so stylesheets and scripts of the page failed. The
// server here behaves like Envoy: its RST_STREAM REFUSED_STREAM go out as FLOW_CONTROL_ERROR.
// Since deps/patches/curl/0003 a new connection takes more requests only after the SETTINGS.
//
//   node tests/core/http2-stream-limit-test.mjs [engine-dir]
import http2 from 'node:http2';
import path from 'node:path';
import { duplexPair, Transform } from 'node:stream';
import tls from 'node:tls';
import { makeCerts } from '../fixtures/certs.mjs';
import {
  TIMEOUT,
  buildDir,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const LIMIT = 4;
const REQUESTS = 24;
const RST_STREAM = 3;
const FLOW_CONTROL_ERROR = 3;
const REFUSED_STREAM = 7;

const PAGE = `<!doctype html><title>limit</title><script>
Promise.all(Array.from({ length: ${REQUESTS} }, (_, i) =>
  fetch('/r/' + i, { cache: 'no-store' }).then((r) => r.text()).then((t) => t === 'ok', () => false),
)).then((results) => console.log('RESULT fetched=' + results.filter(Boolean).length));
</script>`;

// The server behind the TLS front: nghttp2 refuses the streams over its limit
const server = { connections: 0, maxOpen: 0, resets: 0 };
const open = new Map();
const inner = http2.createServer({ settings: { maxConcurrentStreams: LIMIT } });
inner.on('stream', (stream, headers) => {
  const requestPath = headers[':path'] ?? '/';
  if (!requestPath.startsWith('/r/')) {
    stream.respond({ ':status': 200, 'content-type': 'text/html', 'cache-control': 'no-store' });
    stream.end(PAGE);
    return;
  }
  // Per connection, as the limit
  const session = stream.session;
  open.set(session, (open.get(session) ?? 0) + 1);
  server.maxOpen = Math.max(server.maxOpen, open.get(session));
  stream.on('close', () => open.set(session, open.get(session) - 1));
  // Long enough that the requests pile up behind the limit
  setTimeout(() => {
    if (stream.destroyed) return;
    stream.respond({ ':status': 200, 'content-type': 'text/plain', 'cache-control': 'no-store' });
    stream.end('ok');
  }, 300);
});

// Server to client: RST_STREAM REFUSED_STREAM becomes FLOW_CONTROL_ERROR like from Envoy
function envoyResets() {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      let offset = 0;
      while (pending.length - offset >= 9) {
        const end = offset + 9 + pending.readUIntBE(offset, 3);
        if (pending.length < end) break;
        const frame = Buffer.from(pending.subarray(offset, end));
        if (frame[3] === RST_STREAM && frame.readUInt32BE(9) === REFUSED_STREAM) {
          frame.writeUInt32BE(FLOW_CONTROL_ERROR, 9);
          server.resets++;
        }
        this.push(frame);
        offset = end;
      }
      pending = pending.subarray(offset);
      done();
    },
  });
}

const certs = makeCerts(path.join(buildDir, 'e2e-certs'));
const front = tls.createServer({ ...certs.good, ALPNProtocols: ['h2'] }, (socket) => {
  server.connections++;
  const [innerSide, frontSide] = duplexPair();
  inner.emit('connection', innerSide);
  socket.pipe(frontSide);
  frontSide.pipe(envoyResets()).pipe(socket);
  socket.on('error', () => frontSide.destroy());
  socket.on('close', () => frontSide.destroy());
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
const siteURL = `https://127.0.0.1:${front.address().port}`;

const stack = await startStack({ token: 'h2-limit-token-0123456789abcdef' });
const browser = await launch();
const tab = await browser.newPage();
await tab.addInitScript((pem) => {
  window.blTestOptions = { engine: { extraCA: pem } };
}, certs.ca);
const results = collect(tab);

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
await load(tab, `${siteURL}/`);
const fetched = await results.wait('fetched', 60000);
const state = `${fetched}/${REQUESTS} fetched, ${server.resets} streams over the limit reset, at most ${server.maxOpen} open on a connection, ${server.connections} connections`;
check(
  `${REQUESTS} requests at once to a server that allows ${LIMIT} streams`,
  fetched === String(REQUESTS),
  state,
);
check('no stream over the limit of the server', server.resets === 0, state);
check(
  'never more streams open on a connection than the server allows',
  server.maxOpen <= LIMIT,
  state,
);

await browser.close();
front.close();
inner.close();
finish();
