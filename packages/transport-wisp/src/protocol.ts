import type { CloseReason } from '@browser-lite/core';

// Wisp v1, see PROTOCOL.md. Every packet: type (u8) | stream id (u32 LE) | payload.
export const CONNECT = 0x01;
export const DATA = 0x02;
export const CONTINUE = 0x03;
export const CLOSE = 0x04;
export const STREAM_TCP = 0x01;
export const CLOSE_VOLUNTARY = 0x02;

/** Largest DATA payload the client sends; larger writes are split. */
export const MAX_DATA = 64 * 1024;

/** Semantic reason for a Wisp close code. */
export function closeReason(code: number): CloseReason {
  switch (code) {
    case 0x02:
      return 'closed';
    case 0x41:
      return 'invalid';
    case 0x42:
      return 'name-not-resolved';
    case 0x43:
    case 0x47:
      return 'timeout';
    case 0x44:
      return 'refused';
    case 0x48:
      return 'blocked';
    case 0x49:
      return 'throttled';
    case 0x4a:
      return 'unreachable';
    default:
      return 'reset';
  }
}

/** One packet with a 5 byte header in front of `payload`. */
export function encodePacket(
  type: number,
  streamId: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(5 + payload.byteLength);
  packet[0] = type;
  new DataView(packet.buffer).setUint32(1, streamId, true);
  packet.set(payload, 5);
  return packet;
}

/** CONNECT payload for a TCP stream. */
export function connectPayload(host: string, port: number): Uint8Array {
  const name = new TextEncoder().encode(host);
  const payload = new Uint8Array(3 + name.length);
  payload[0] = STREAM_TCP;
  new DataView(payload.buffer).setUint16(1, port, true);
  payload.set(name, 3);
  return payload;
}
