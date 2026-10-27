import type { TransportStream } from '@browser-lite/core';
import { WispErrorEvent, type WispTransportOptions } from './api.js';
import {
  CLOSE,
  CONNECT,
  CONTINUE,
  closeReason,
  DATA,
  encodePacket,
  STREAM_TCP,
} from './protocol.js';
import { type StreamLink, WispStream } from './stream.js';

const OPEN = 1;
const SUBPROTOCOL = 'wisp';
const TOKEN_SUBPROTOCOL = 'bl-token.';
const HANDSHAKE_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;
/** Close codes of a relay that refuses the token after the upgrade. */
const UNAUTHORIZED = new Set([4401, 4403]);
const SILENCE_MS = 10000;
const PROBE_TIMEOUT_MS = 5000;
// Acknowledgement of the received bytes (CONTINUE on stream 0, PROTOCOL.md): after this many
// bytes, or this long after the first unacknowledged one
const ACK_BYTES = 32 * 1024;
const ACK_DELAY_MS = 5;

/**
 * One WebSocket to a Wisp v1 relay with its TCP streams: flow control, reconnect, dead connection
 * probe. Dispatches `connectedchange` when {@link connected} changes and a {@link WispErrorEvent}
 * `error` when the relay refuses the token. The WebSocket is opened with {@link preconnect} or
 * the first stream; after that the session keeps reconnecting until {@link close}.
 * {@link WispTransport} spreads its streams over several sessions.
 */
export class WispSession extends EventTarget {
  private readonly streams = new Map<number, WispStream>();
  private nextStreamId = 1;
  private bufferSize = 0;
  private ready: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private isConnected = true;
  private isClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDrop = 0;
  /** Refused tokens in a row: the retries slow down. */
  private authFailures = 0;
  // Is the connection still alive? (expectAnswer)
  private received = 0;
  private sent = 0;
  /** Bytes received on the current WebSocket, and how many of them were acknowledged. */
  private receivedBytes = 0;
  private ackedBytes = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private drop: (() => void) | null = null;
  private readonly link: StreamLink;
  private readonly onOnline = () => this.probe();

  constructor(
    private readonly url: URL,
    private readonly token: WispTransportOptions['token'],
    private readonly WebSocketClass: typeof WebSocket,
  ) {
    super();
    const session = this;
    this.link = {
      sendPacket: (type, streamId, payload) => this.sendPacket(type, streamId, payload),
      get bufferSize() {
        return session.bufferSize;
      },
      forget: (streamId) => this.streams.delete(streamId),
    };
    // After a network change the old connection is often dead without closing
    if (typeof globalThis.addEventListener === 'function')
      globalThis.addEventListener('online', this.onOnline);
  }

  /** Open streams of this session. */
  get streamCount(): number {
    return this.streams.size;
  }

  /** False while the relay cannot be reached (pages see `navigator.onLine` false). */
  get connected(): boolean {
    return this.isConnected;
  }

  /** Opens a TCP stream to host:port through the relay. */
  openTCP(host: string, port: number): TransportStream {
    const stream = new WispStream(this.link, this.nextStreamId++, host, port);
    if (this.isClosed) {
      queueMicrotask(() => stream.closed('transport-down'));
      return stream;
    }
    this.streams.set(stream.id, stream);
    this.connect().then(
      () => stream.start(),
      () => {
        this.streams.delete(stream.id);
        stream.closed('transport-down');
      },
    );
    return stream;
  }

  /** Opens the WebSocket now instead of with the first stream. */
  preconnect(): void {
    if (!this.isClosed) this.connect().catch(() => {});
  }

  /** Closes the WebSocket and all streams; the session does not reconnect anymore. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (typeof globalThis.removeEventListener === 'function')
      globalThis.removeEventListener('online', this.onOnline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.drop?.();
    this.ws?.close();
    this.closeStreams();
    this.setConnected(false);
  }

  // Subprotocol values allow only a few characters, hence base64url. Without a token none: a
  // server that answers without one fails the handshake in browsers otherwise
  private async protocols(): Promise<string[]> {
    if (this.token === undefined) return [];
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    let binary = '';
    for (const byte of new TextEncoder().encode(token)) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return [SUBPROTOCOL, TOKEN_SUBPROTOCOL + encoded];
  }

  private closeStreams(): void {
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.closed('transport-down');
  }

  // Every WebSocket has its own handshake. A connection that breaks is replaced right away
  // (for example after a restart of the relay or a proxy closing it when idle).
  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = this.protocols().then(
      (protocols) => this.openSocket(protocols),
      (error: unknown) => {
        this.ready = null;
        this.setConnected(false);
        throw error;
      },
    );
    this.ready = ready;
    return ready;
  }

  private openSocket(protocols: string[]): Promise<void> {
    if (this.isClosed) {
      this.ready = null;
      return Promise.reject(new Error('transport closed'));
    }
    let ws: WebSocket;
    try {
      ws = new this.WebSocketClass(this.url.href, protocols);
    } catch (error) {
      this.ready = null;
      this.setConnected(false);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.sent = 0;
      this.receivedBytes = this.ackedBytes = 0;
      let handshake = false;
      let closed = false;
      const onClosed = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        if (this.ws === ws) {
          this.ready = null;
          this.drop = null;
          if (this.watchdog) clearTimeout(this.watchdog);
          if (this.probeTimer) clearTimeout(this.probeTimer);
          this.watchdog = this.probeTimer = null;
        }
        this.closeStreams();
        if (!handshake) reject(new Error(`Wisp connection failed: ${this.url}`));
        if (this.isClosed) return;
        // A working connection that breaks is reconnected once right away: offline only if
        // that fails
        if (handshake && Date.now() - this.lastDrop > RECONNECT_DELAY_MS) {
          this.lastDrop = Date.now();
          this.connect().catch(() => {});
        } else {
          this.setConnected(false);
        }
      };
      // Give up at once, without waiting for the WebSocket to close
      const drop = () => {
        onClosed();
        ws.close();
      };
      // Something that answers without Wisp (for example a proxy): do not wait forever
      const timeout = setTimeout(drop, HANDSHAKE_TIMEOUT_MS);
      ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (closed) return;
        const packet = new Uint8Array(event.data);
        if (handshake) {
          this.received++;
          this.receivedBytes += packet.byteLength;
          this.acknowledge();
          if (this.probeTimer) clearTimeout(this.probeTimer);
          this.probeTimer = null;
          this.handlePacket(packet);
          return;
        }
        // The first CONTINUE on stream 0 announces the buffer size
        const view = new DataView(event.data);
        if (packet.length >= 9 && packet[0] === CONTINUE && view.getUint32(1, true) === 0) {
          handshake = true;
          this.authFailures = 0;
          clearTimeout(timeout);
          this.bufferSize = view.getUint32(5, true);
          this.drop = drop;
          // Acknowledged at once: our relay then keeps its data on the way small from the start
          this.receivedBytes = packet.byteLength;
          this.sendAck();
          resolve();
          this.setConnected(true);
        }
      };
      ws.onclose = (event?: CloseEvent) => {
        if (!handshake && UNAUTHORIZED.has(event?.code ?? 0)) this.unauthorized();
        onClosed();
      };
      // Node (undici) only reports error, no close, for a refused handshake
      ws.onerror = onClosed;
    });
  }

  private unauthorized(): void {
    this.authFailures++;
    // The error event of the browser may have scheduled the retry already: use the new delay
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.scheduleReconnect();
    }
    this.dispatchEvent(new WispErrorEvent('unauthorized'));
  }

  private scheduleReconnect(): void {
    if (this.isClosed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** this.authFailures, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  private setConnected(connected: boolean): void {
    if (!connected) this.scheduleReconnect();
    if (connected === this.isConnected) return;
    this.isConnected = connected;
    this.dispatchEvent(new Event('connectedchange'));
  }

  private sendPacket(type: number, streamId: number, payload: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || !this.drop) return false;
    const packet = encodePacket(type, streamId, payload);
    ws.send(packet);
    this.sent += packet.byteLength;
    if (type !== CLOSE) this.expectAnswer();
    return true;
  }

  // Tells the relay what arrived, so it keeps only about two round trips of data on the way
  // instead of filling the buffers of the operating system: a small response of one stream would
  // wait behind them (PROTOCOL.md)
  private acknowledge(): void {
    if (this.receivedBytes - this.ackedBytes >= ACK_BYTES) this.sendAck();
    else if (!this.ackTimer) this.ackTimer = setTimeout(() => this.sendAck(), ACK_DELAY_MS);
  }

  private sendAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || this.receivedBytes === this.ackedBytes) return;
    this.ackedBytes = this.receivedBytes;
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, this.receivedBytes >>> 0, true);
    const packet = encodePacket(CONTINUE, 0, payload);
    ws.send(packet);
    this.sent += packet.byteLength;
  }

  // Wisp has no ping. If nothing at all comes back 10 s after sending (half open connection, for
  // example after sleep), the transport asks: a CONNECT to an empty target must be answered by
  // the relay with CLOSE at once. If that does not come either, the connection is dead: close it
  // (the streams end with transport-down) and reconnect. The question would queue behind
  // everything still in the WebSocket buffer (slow upload): while that drains the connection
  // lives, and the question is only sent once it is empty. What already sits in the buffer of the
  // operating system is invisible to the page: for that our relay sends a CONTINUE on stream 0 at
  // least every 3 s while streams are open.
  private expectAnswer(): void {
    if (this.watchdog || this.probeTimer) return;
    const received = this.received;
    const drained = this.drained();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.received === received) this.probe(drained);
    }, SILENCE_MS);
  }

  // Bytes the WebSocket has handed to the network so far
  private drained(): number {
    return this.sent - (this.ws?.bufferedAmount ?? 0);
  }

  // drained: state before the silence (expectAnswer)
  private probe(drained = -1): void {
    const ws = this.ws;
    if (this.probeTimer || !this.drop || ws?.readyState !== OPEN) return;
    if (ws.bufferedAmount > 0) {
      if (this.drained() > drained) this.expectAnswer();
      else this.drop(); // nothing drained for 10 s
      return;
    }
    this.probeTimer = setTimeout(this.drop, PROBE_TIMEOUT_MS);
    this.sendPacket(CONNECT, this.nextStreamId++, Uint8Array.of(STREAM_TCP, 0, 0));
  }

  private handlePacket(packet: Uint8Array): void {
    if (packet.length < 5) return;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const stream = this.streams.get(view.getUint32(1, true));
    if (!stream) return;
    switch (packet[0]) {
      case DATA:
        stream.received(packet.subarray(5));
        break;
      case CONTINUE:
        if (packet.length >= 9) stream.setCredit(view.getUint32(5, true));
        break;
      case CLOSE:
        this.streams.delete(stream.id);
        stream.closed(closeReason(packet[5] ?? 0));
        break;
      default:
        // Wisp v2 INFO and unknown types
        break;
    }
  }
}
