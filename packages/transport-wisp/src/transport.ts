import type { Transport, TransportStream } from '@browser-lite/core';
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

/** Options of {@link WispTransport}. */
export interface WispTransportOptions {
  /**
   * WebSocket URL of the relay, for example `wss://example.org/wisp/`. Relative URLs resolve
   * against `location`; `http:` and `https:` stand for `ws:` and `wss:`.
   */
  url: string | URL;
  /**
   * Token for the relay, sent on every (re)connect as the WebSocket subprotocol
   * `bl-token.<base64url of the token>` next to `wisp` (never in the URL, which ends up in proxy
   * logs). A function is called for each connect, so it can fetch a fresh signed token.
   */
  token?: string | (() => string | Promise<string>);
}

const OPEN = 1;
const SUBPROTOCOL = 'wisp';
const TOKEN_SUBPROTOCOL = 'bl-token.';
const HANDSHAKE_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 2000;
const SILENCE_MS = 10000;
const PROBE_TIMEOUT_MS = 5000;

/**
 * Transport of the engine over a Wisp v1 relay (TCP over one WebSocket): flow control,
 * reconnect, dead connection probe. Dispatches `connectedchange` when {@link connected} changes.
 * The WebSocket is opened with the first stream; after that the transport keeps reconnecting
 * until {@link close}. Uses the `WebSocket` of `globalThis` at construction time.
 */
export class WispTransport extends EventTarget implements Transport {
  private readonly url: URL;
  private readonly token: WispTransportOptions['token'];
  private readonly WebSocketClass: typeof WebSocket;
  private readonly streams = new Map<number, WispStream>();
  private nextStreamId = 1;
  private bufferSize = 0;
  private ready: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private isConnected = true;
  private isClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDrop = 0;
  // Is the connection still alive? (expectAnswer)
  private received = 0;
  private sent = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private drop: (() => void) | null = null;
  private readonly link: StreamLink;
  private readonly onOnline = () => this.probe();

  constructor(o: WispTransportOptions) {
    super();
    if (!o || (typeof o.url !== 'string' && !(o.url instanceof URL)))
      throw new TypeError('WispTransport: url is required');
    const base = (globalThis as { location?: { href: string } }).location?.href;
    this.url = new URL(o.url, base);
    // Older browsers only accept ws: and wss: in the WebSocket constructor
    if (this.url.protocol === 'http:') this.url.protocol = 'ws:';
    else if (this.url.protocol === 'https:') this.url.protocol = 'wss:';
    if (this.url.protocol !== 'ws:' && this.url.protocol !== 'wss:')
      throw new TypeError(`WispTransport: not a WebSocket URL: ${this.url.href}`);
    this.token = o.token;
    this.WebSocketClass = globalThis.WebSocket;
    const transport = this;
    this.link = {
      sendPacket: (type, streamId, payload) => this.sendPacket(type, streamId, payload),
      get bufferSize() {
        return transport.bufferSize;
      },
      forget: (streamId) => this.streams.delete(streamId),
    };
    // After a network change the old connection is often dead without closing
    if (typeof globalThis.addEventListener === 'function')
      globalThis.addEventListener('online', this.onOnline);
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

  /** Closes the WebSocket and all streams; the transport does not reconnect anymore. */
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
          if (this.probeTimer) clearTimeout(this.probeTimer);
          this.probeTimer = null;
          this.handlePacket(packet);
          return;
        }
        // The first CONTINUE on stream 0 announces the buffer size
        const view = new DataView(event.data);
        if (packet.length >= 9 && packet[0] === CONTINUE && view.getUint32(1, true) === 0) {
          handshake = true;
          clearTimeout(timeout);
          this.bufferSize = view.getUint32(5, true);
          this.drop = drop;
          resolve();
          this.setConnected(true);
        }
      };
      ws.onclose = onClosed;
      // Node (undici) only reports error, no close, for a refused handshake
      ws.onerror = onClosed;
    });
  }

  private setConnected(connected: boolean): void {
    if (!connected && !this.isClosed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => {});
      }, RECONNECT_DELAY_MS);
    }
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
