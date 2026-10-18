// Wisp v1 framing, see packages/transport-wisp/PROTOCOL.md.
// Every packet: type (u8) | stream id (u32 LE) | payload.

export const CONNECT = 0x01;
export const DATA = 0x02;
export const CONTINUE = 0x03;
export const CLOSE = 0x04;

export const STREAM_TCP = 0x01;

/** Close reasons sent by the relay. */
export const Reason = {
  unknown: 0x01,
  voluntary: 0x02,
  networkError: 0x03,
  invalid: 0x41,
  unreachableHost: 0x42,
  noResponse: 0x43,
  refused: 0x44,
  timeout: 0x47,
  blocked: 0x48,
  throttled: 0x49,
  addressUnreachable: 0x4a,
} as const;

/** WebSocket subprotocol of the relay; the only one it ever answers with. */
export const SUBPROTOCOL = 'wisp';
/** Prefix of the subprotocol entry that carries the token (`bl-token.<base64url of the token>`). */
export const TOKEN_SUBPROTOCOL = 'bl-token.';

/** Packets a client may send before it receives a CONTINUE on its stream. */
export const BUFFER_SIZE = 128;

export interface Packet {
  type: number;
  streamId: number;
  payload: Buffer;
}

/** Parses one WebSocket message; null if it is shorter than the header. */
export function parsePacket(data: Buffer): Packet | null {
  if (data.length < 5) return null;
  return { type: data[0] as number, streamId: data.readUInt32LE(1), payload: data.subarray(5) };
}

function header(type: number, streamId: number, length: number): Buffer {
  const packet = Buffer.allocUnsafe(5 + length);
  packet[0] = type;
  packet.writeUInt32LE(streamId, 1);
  return packet;
}

export function dataPacket(streamId: number, payload: Buffer): Buffer {
  const packet = header(DATA, streamId, payload.length);
  payload.copy(packet, 5);
  return packet;
}

export function continuePacket(streamId: number, bufferRemaining: number): Buffer {
  const packet = header(CONTINUE, streamId, 4);
  packet.writeUInt32LE(bufferRemaining, 5);
  return packet;
}

export function closePacket(streamId: number, reason: number): Buffer {
  const packet = header(CLOSE, streamId, 1);
  packet[5] = reason;
  return packet;
}

export interface ConnectRequest {
  streamType: number;
  port: number;
  hostname: string;
}

/** Parses a CONNECT payload; null if it is too short. */
export function parseConnect(payload: Buffer): ConnectRequest | null {
  if (payload.length < 3) return null;
  return {
    streamType: payload[0] as number,
    port: payload.readUInt16LE(1),
    hostname: payload.subarray(3).toString('utf8'),
  };
}
