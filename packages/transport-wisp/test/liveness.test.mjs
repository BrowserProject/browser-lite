// Client side behaviour against stand-in relays: mapping of every Wisp close code, the dead
// connection probe (half open connection), slow uploads and keepalives of the relay.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { WispTransport } from '../dist/index.js';
import { waitUntil, within } from './helpers.mjs';

const INVALID = 0x41;
const HANDSHAKE = Uint8Array.of(0x03, 0, 0, 0, 0, 128, 0, 0, 0);

async function standIn(onPacket) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.on('listening', resolve));
  server.connections = 0;
  server.on('connection', (ws) => {
    server.connections++;
    ws.send(HANDSHAKE);
    ws.on('message', (data) => onPacket(ws, new Uint8Array(data)));
  });
  server.url = `ws://127.0.0.1:${server.address().port}/`;
  return server;
}

test('every Wisp close code maps to its reason', async () => {
  const server = await standIn((ws, packet) => {
    if (packet[0] !== 0x01) return;
    const code = Number.parseInt(Buffer.from(packet.subarray(8)).toString(), 16);
    ws.send(Uint8Array.of(0x04, ...packet.subarray(1, 5), code));
  });
  const transport = new WispTransport({ connections: 1, url: server.url });
  const expected = {
    '02': 'closed',
    '01': 'reset',
    '03': 'reset',
    41: 'invalid',
    42: 'name-not-resolved',
    43: 'timeout',
    44: 'refused',
    47: 'timeout',
    48: 'blocked',
    49: 'throttled',
    '4a': 'unreachable',
    ff: 'reset',
  };
  try {
    for (const [code, reason] of Object.entries(expected)) {
      const stream = transport.openTCP(code, 443);
      const got = await within(
        new Promise((resolve) => {
          stream.onclose = resolve;
        }),
        3000,
        null,
      );
      assert.equal(got, reason, `0x${code}`);
    }
  } finally {
    transport.close();
    server.close();
  }
});

// A relay that says nothing after the handshake (like after sleep): the transport asks, gets no
// answer, closes the streams with transport-down and reconnects. If the relay answers the
// question (like a long poll without data for a long time), the stream stays open.
test('dead connection probe', async () => {
  let answerProbes = true;
  const server = await standIn((ws, packet) => {
    // CONNECT to port 0 is the question
    if (answerProbes && packet[0] === 0x01 && packet[6] === 0 && packet[7] === 0)
      ws.send(Uint8Array.of(0x04, ...packet.subarray(1, 5), INVALID));
  });
  const transport = new WispTransport({ connections: 1, url: server.url });
  const waitForAnswer = async (ms) => {
    const stream = transport.openTCP('example.org', 80);
    stream.onopen = () => stream.send(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'));
    const started = Date.now();
    const reason = await within(
      new Promise((resolve) => {
        stream.onclose = resolve;
      }),
      ms,
      null,
    );
    stream.close();
    return { reason, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  };
  try {
    const alive = await waitForAnswer(18000);
    assert.equal(alive.reason, null, JSON.stringify(alive));
    assert.equal(server.connections, 1);
    answerProbes = false;
    const dead = await waitForAnswer(25000);
    assert.equal(dead.reason, 'transport-down', JSON.stringify(dead));
    assert.ok(await waitUntil(() => server.connections === 2, 3000), 'new connection afterwards');
    assert.equal(transport.connected, true);
  } finally {
    transport.close();
    server.close();
  }
});

// A WebSocket over a slow line to a relay that lives: it answers the question as soon as it
// arrives and says nothing otherwise. The upload takes longer than the transport waits for an
// answer: it must not give up. If the line stalls (rate 0, the buffer never drains), it is dead.
// If the upload sits outside the WebSocket (operating system buffer, bufferedAmount 0), the
// keepalive of the relay (CONTINUE on stream 0) keeps the connection.
test('slow uploads, stalled lines and relay keepalives', async () => {
  class SlowLink {
    static OPEN = 1;
    static links = new Map();
    constructor(url) {
      const params = new URL(url).searchParams;
      this.rate = Number(params.get('rate'));
      this.hidden = params.has('hidden');
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.queue = [];
      this.offset = 0;
      this.uploaded = 0;
      SlowLink.links.set(url, this);
      setTimeout(() => {
        this.readyState = 1;
        this.deliver(HANDSHAKE);
      }, 10);
      this.timer = setInterval(() => this.transfer(this.rate / 10), 100);
      if (this.hidden) this.keepalive = setInterval(() => this.deliver(HANDSHAKE), 3000);
    }
    deliver(packet) {
      this.onmessage?.({ data: packet.slice().buffer });
    }
    send(packet) {
      this.queue.push(packet);
      if (!this.hidden) this.bufferedAmount += packet.byteLength;
    }
    transfer(budget) {
      let left = budget;
      while (left > 0 && this.queue.length) {
        const packet = this.queue[0];
        const part = Math.min(left, packet.byteLength - this.offset);
        left -= part;
        this.offset += part;
        if (!this.hidden) this.bufferedAmount -= part;
        if (this.offset < packet.byteLength) break;
        this.queue.shift();
        this.offset = 0;
        if (packet[0] === 0x02) this.uploaded += packet.byteLength - 5;
        if (packet[0] === 0x01 && packet[6] === 0 && packet[7] === 0)
          this.deliver(Uint8Array.of(0x04, ...packet.subarray(1, 5), INVALID));
      }
    }
    close() {
      clearInterval(this.timer);
      clearInterval(this.keepalive);
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const PACKET = 32 * 1024;
  const upload = async (rate, packets, ms, hidden = false) => {
    const native = globalThis.WebSocket;
    globalThis.WebSocket = SlowLink;
    const url = `ws://slow/?rate=${rate}&packets=${packets}${hidden ? '&hidden' : ''}`;
    let transport;
    try {
      transport = new WispTransport({ connections: 1, url });
    } finally {
      globalThis.WebSocket = native;
    }
    const stream = transport.openTCP('example.org', 80);
    stream.onopen = () => {
      for (let i = 0; i < packets; i++) stream.send(new Uint8Array(PACKET));
    };
    await waitUntil(() => SlowLink.links.has(url), 1000);
    const link = SlowLink.links.get(url);
    const reason = await within(
      new Promise((resolve) => {
        stream.onclose = resolve;
      }),
      ms,
      null,
    );
    const { uploaded } = link;
    transport.close();
    link.close();
    return { reason, uploaded };
  };
  // 1.8 MB at 100 KB/s: the question after 10 s would only arrive after 18 s
  const [slow, hidden, stalled] = await Promise.all([
    upload(100 * 1024, 56, 23000),
    upload(100 * 1024, 56, 23000, true),
    upload(0, 4, 15000),
  ]);
  assert.deepEqual(slow, { reason: null, uploaded: 56 * PACKET }, 'slow upload completes');
  assert.deepEqual(hidden, { reason: null, uploaded: 56 * PACKET }, 'keepalive holds');
  assert.equal(stalled.reason, 'transport-down', JSON.stringify(stalled));
});
