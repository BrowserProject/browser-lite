import type { Transport, TransportStream } from '@browser-lite/core';
import { WispErrorEvent, type WispTransportOptions } from './api.js';
import { WispSession } from './session.js';

const DEFAULT_CONNECTIONS = 3;
const MAX_CONNECTIONS = 8;
/** Refused tokens of several WebSockets at once are one `error`. */
const ERROR_INTERVAL_MS = 1000;

/**
 * Transport of the engine over a Wisp v1 relay: TCP streams over several WebSockets
 * ({@link WispTransportOptions.connections}), each with flow control, reconnect and a dead
 * connection probe; a new stream goes to the connected WebSocket with the fewest streams.
 * Dispatches `connectedchange` when {@link connected} changes and a {@link WispErrorEvent}
 * `error` when the relay refuses the token. The WebSockets open with {@link preconnect} or the
 * first streams; after that the transport keeps reconnecting until {@link close}, also after the
 * browser was destroyed: close it when it is no longer used. Uses the `WebSocket` of
 * `globalThis` at construction time.
 */
export class WispTransport extends EventTarget implements Transport {
  private readonly sessions: WispSession[];
  private isConnected = true;
  private lastError = 0;

  constructor(o: WispTransportOptions) {
    super();
    if (!o || (typeof o.url !== 'string' && !(o.url instanceof URL)))
      throw new TypeError('WispTransport: url is required');
    const base = (globalThis as { location?: { href: string } }).location?.href;
    const url = new URL(o.url, base);
    // Older browsers only accept ws: and wss: in the WebSocket constructor
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
      throw new TypeError(`WispTransport: not a WebSocket URL: ${url.href}`);
    const count = o.connections ?? DEFAULT_CONNECTIONS;
    if (!Number.isInteger(count) || count < 1 || count > MAX_CONNECTIONS)
      throw new TypeError(`WispTransport: connections must be 1 to ${MAX_CONNECTIONS}`);
    const WebSocketClass = globalThis.WebSocket;
    this.sessions = Array.from({ length: count }, () => {
      const session = new WispSession(url, o.token, WebSocketClass);
      session.addEventListener('connectedchange', () => this.updateConnected());
      session.addEventListener('error', (event) => {
        if (Date.now() - this.lastError < ERROR_INTERVAL_MS) return;
        this.lastError = Date.now();
        this.dispatchEvent(new WispErrorEvent((event as WispErrorEvent).reason));
      });
      return session;
    });
  }

  /** False while the relay cannot be reached (pages see `navigator.onLine` false). */
  get connected(): boolean {
    return this.isConnected;
  }

  /** Opens a TCP stream to host:port through the relay. */
  openTCP(host: string, port: number): TransportStream {
    let best = this.sessions[0] as WispSession;
    for (const session of this.sessions) {
      const better =
        session.connected !== best.connected
          ? session.connected
          : session.streamCount < best.streamCount;
      if (better) best = session;
    }
    return best.openTCP(host, port);
  }

  /** Opens the WebSockets now instead of with the first streams (`createBrowser` calls it). */
  preconnect(): void {
    for (const session of this.sessions) session.preconnect();
  }

  /** Closes the WebSockets and all streams; the transport does not reconnect anymore. */
  close(): void {
    for (const session of this.sessions) session.close();
  }

  // Connected while one WebSocket is
  private updateConnected(): void {
    const connected = this.sessions.some((session) => session.connected);
    if (connected === this.isConnected) return;
    this.isConnected = connected;
    this.dispatchEvent(new Event('connectedchange'));
  }
}
