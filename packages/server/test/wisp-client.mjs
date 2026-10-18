// Minimal raw Wisp v1 client for protocol level tests.
import { once } from 'node:events';
import WebSocket from 'ws';

export const CONNECT = 0x01;
export const DATA = 0x02;
export const CONTINUE = 0x03;
export const CLOSE = 0x04;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function packet(type, streamId, payload = Buffer.alloc(0)) {
  const data = Buffer.alloc(5 + payload.length);
  data[0] = type;
  data.writeUInt32LE(streamId, 1);
  Buffer.from(payload).copy(data, 5);
  return data;
}

export function connectPayload(host, port, type = 0x01) {
  const name = Buffer.from(host);
  const payload = Buffer.alloc(3 + name.length);
  payload[0] = type;
  payload.writeUInt16LE(port, 1);
  name.copy(payload, 3);
  return payload;
}

/** Subprotocols that carry a token, as WispTransport sends them. */
export const withToken = (token) => [
  'wisp',
  `bl-token.${Buffer.from(token).toString('base64url')}`,
];

/** Upgrade result: { status } for a refused upgrade, or a connected RawWisp. */
export async function open(url, { protocols = [], ...options } = {}) {
  const ws = new WebSocket(url, protocols, options);
  const result = await new Promise((resolve) => {
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once('error', (error) => resolve({ status: 0, error }));
    ws.once('message', (data) => resolve({ client: new RawWisp(ws, data) }));
  });
  if (result.client) return result.client;
  return result;
}

export class RawWisp {
  constructor(ws, first) {
    this.ws = ws;
    this.packets = [];
    this.closeCode = null;
    this.bufferSize = first.readUInt32LE(5);
    this.firstType = first[0];
    this.closed = once(ws, 'close').then(([code]) => {
      this.closeCode = code;
      return code;
    });
    ws.on('message', (data) => {
      this.packets.push({
        type: data[0],
        streamId: data.readUInt32LE(1),
        payload: data.subarray(5),
      });
    });
  }

  send(type, streamId, payload) {
    this.ws.send(packet(type, streamId, payload));
  }

  connectTCP(streamId, host, port, type = 0x01) {
    this.send(CONNECT, streamId, connectPayload(host, port, type));
  }

  data(streamId) {
    return Buffer.concat(
      this.packets.filter((p) => p.type === DATA && p.streamId === streamId).map((p) => p.payload),
    );
  }

  async waitFor(predicate, ms = 5000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
      const found = this.packets.find(predicate);
      if (found) return found;
    }
    return this.packets.find(predicate) ?? null;
  }

  /** Close reason the relay sent for a stream, null if none within ms. */
  async closeReason(streamId, ms = 5000) {
    const found = await this.waitFor((p) => p.type === CLOSE && p.streamId === streamId, ms);
    return found ? found.payload[0] : null;
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}
