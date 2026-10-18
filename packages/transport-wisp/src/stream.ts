import type { CloseReason, TransportStream } from '@browser-lite/core';
import { CLOSE, CLOSE_VOLUNTARY, CONNECT, connectPayload, DATA, MAX_DATA } from './protocol.js';

/** What a stream needs from its transport. */
export interface StreamLink {
  /** Sends a packet if the WebSocket is open; returns false otherwise. */
  sendPacket(type: number, streamId: number, payload: Uint8Array): boolean;
  /** Packets a new stream may send before the first CONTINUE. */
  readonly bufferSize: number;
  forget(streamId: number): void;
}

/** One TCP stream over a Wisp connection. */
export class WispStream implements TransportStream {
  onopen: (() => void) | null = null;
  ondata: ((data: Uint8Array) => void) | null = null;
  onsent: ((bytes: number) => void) | null = null;
  onclose: ((reason: CloseReason) => void) | null = null;
  private credit = 0;
  private queue: Uint8Array[] = [];
  private isOpen = false;
  private isClosed = false;

  constructor(
    private readonly link: StreamLink,
    readonly id: number,
    private readonly host: string,
    private readonly port: number,
  ) {}

  /** Sends CONNECT. Wisp does not confirm it, so the stream counts as open right away. */
  start(): void {
    if (this.isClosed) return;
    this.link.sendPacket(CONNECT, this.id, connectPayload(this.host, this.port));
    this.credit = this.link.bufferSize;
    this.isOpen = true;
    this.onopen?.();
    this.flush();
  }

  send(data: Uint8Array): void {
    if (this.isClosed) return;
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA)
      this.queue.push(data.subarray(offset, offset + MAX_DATA));
    this.flush();
  }

  /** New credit from a CONTINUE of the relay. */
  setCredit(credit: number): void {
    this.credit = credit;
    this.flush();
  }

  // Flow control: only as many packets as the relay allows
  private flush(): void {
    let sent = 0;
    while (this.isOpen && this.queue.length && this.credit > 0) {
      const data = this.queue[0] as Uint8Array;
      if (!this.link.sendPacket(DATA, this.id, data)) break;
      this.queue.shift();
      this.credit--;
      sent += data.byteLength;
    }
    if (sent) this.onsent?.(sent);
  }

  received(data: Uint8Array): void {
    this.ondata?.(data);
  }

  close(): void {
    if (this.isClosed) return;
    if (this.isOpen) this.link.sendPacket(CLOSE, this.id, Uint8Array.of(CLOSE_VOLUNTARY));
    this.link.forget(this.id);
    this.closed('closed');
  }

  /** The stream ended for `reason`; calls onclose once. */
  closed(reason: CloseReason): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.isOpen = false;
    this.queue = [];
    this.onclose?.(reason);
  }
}
