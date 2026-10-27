import type net from 'node:net';
import type { WebSocket } from 'ws';
import { portAllowed, type RelayPolicy } from '../policy.js';
import {
  BUFFER_SIZE,
  CLOSE,
  CONNECT,
  CONTINUE,
  type ConnectRequest,
  closePacket,
  continuePacket,
  DATA,
  dataPacket,
  parseConnect,
  parsePacket,
  Reason,
  STREAM_TCP,
} from './protocol.js';
import { allowedAddresses, ConnectError, connectSocket, reasonForError } from './target.js';
import { DeliveryWindow } from './window.js';

/** Without other traffic, a CONTINUE on stream 0 at least this often while streams are open. */
const KEEPALIVE_MS = 3000;
/** WebSocket ping interval; a client that misses one pong is dropped. */
const PING_MS = 30000;
/** Above this many buffered bytes towards the client, targets that send are held. */
const SEND_BUFFER = 8 * 1024 * 1024;
/** How long a target may still read what the client sent before its stream was closed. */
const CLOSE_TIMEOUT_MS = 10000;
/** Packets a stream may have unwritten; more means the client ignores flow control. */
const QUEUE_LIMIT = BUFFER_SIZE * 4;
/** Unwritten client bytes of all streams of a connection (draining ones too), at least. */
const CONNECTION_QUEUE_BYTES = 32 * 1024 * 1024;

export interface ConnectionOptions {
  policy: RelayPolicy;
  allowAddress: (address: string) => boolean;
  logger: Pick<Console, 'warn' | 'error'>;
}

// Target as in Chrome's socket pools: lower-case name without trailing dot, and port
const targetKey = (hostname: string, port: number) =>
  `${hostname.toLowerCase().replace(/\.$/, '')}:${port}`;

// Printable ASCII only: the engine sends punycode names and IP literals
const validHostname = (hostname: string) =>
  hostname.length <= 253 && /^[\x21-\x7e]+$/.test(hostname);

class Stream {
  socket: net.Socket | null = null;
  connected = false;
  /** The client closed the stream, or the relay sent CLOSE. */
  closed = false;
  failure: number = Reason.networkError;
  /** Client packets not yet handed to the operating system. */
  queued = 0;
  /** Bytes of these packets. */
  queuedBytes = 0;
  /** Client packets written since the last CONTINUE. */
  written = 0;
  /** Client packets that arrived before the socket existed. */
  pending: Buffer[] = [];
  idleTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: number,
    readonly key: string,
  ) {}
}

/** One Wisp v1 session on an accepted WebSocket. */
export class WispConnection {
  private readonly streams = new Map<number, Stream>();
  /** Streams the client closed whose socket still writes what the client sent. */
  private readonly draining = new Set<Stream>();
  /** Per stream: what flow control allows, with room for packets in flight. */
  private readonly streamQueueBytes: number;
  private readonly connectionQueueBytes: number;
  private lastSend = 0;
  private alive = true;
  /** Streams whose target is not read while the client does not keep up. */
  private readonly held = new Set<Stream>();
  /** Bytes on the way to a client that acknowledges them (window.ts). */
  private readonly window = new DeliveryWindow();
  private readonly timers: NodeJS.Timeout[] = [];
  private resumeTimer: NodeJS.Timeout | null = null;
  /** Resolves when the WebSocket is closed and every stream is cleaned up. */
  readonly closed: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: ConnectionOptions,
  ) {
    this.streamQueueBytes = 2 * BUFFER_SIZE * options.policy.maxPayload;
    this.connectionQueueBytes = Math.max(CONNECTION_QUEUE_BYTES, this.streamQueueBytes);
    this.closed = new Promise((resolve) => ws.once('close', () => resolve(this.cleanup())));
    ws.on('message', (data, isBinary) => this.receive(data as Buffer, isBinary));
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('error', () => ws.terminate());
    this.timers.push(
      setInterval(() => {
        if (this.streams.size && Date.now() - this.lastSend >= KEEPALIVE_MS)
          this.send(continuePacket(0, BUFFER_SIZE));
      }, KEEPALIVE_MS / 3),
      setInterval(() => {
        if (!this.alive) {
          ws.terminate();
          return;
        }
        this.alive = false;
        ws.ping();
      }, PING_MS),
    );
    for (const timer of this.timers) timer.unref();
    this.send(continuePacket(0, BUFFER_SIZE));
  }

  /** Closes the WebSocket (going away) and all streams. */
  close(): Promise<void> {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(1001, 'relay shutting down');
      setTimeout(() => this.ws.terminate(), 1000).unref();
    }
    return this.closed;
  }

  private send(packet: Buffer): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(packet);
    this.lastSend = Date.now();
    this.window.onSent(packet.length, this.lastSend);
  }

  // Backpressure at the source: while the client does not keep up, a target that sent is not read
  // any more. Only the ones that send: a target that has not sent yet gets its first data out at
  // once, so a small response does not wait behind the large ones (holding all at once also let
  // a resumed socket that never read be paused again before it started)
  private holdIfBehind(stream: Stream): void {
    const behind = this.ws.bufferedAmount > SEND_BUFFER || this.window.full;
    if (!behind || this.held.has(stream)) return;
    this.held.add(stream);
    stream.socket?.pause();
    this.resumeTimer ??= setInterval(() => this.releaseHeld(), 10);
  }

  private releaseHeld(): void {
    const sending = this.ws.readyState === this.ws.OPEN;
    if (sending && (this.ws.bufferedAmount > SEND_BUFFER / 2 || !this.window.open)) return;
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    for (const stream of this.held) stream.socket?.resume();
    this.held.clear();
  }

  private receive(data: Buffer, isBinary: boolean): void {
    this.alive = true;
    if (!isBinary) {
      this.ws.close(1003, 'binary frames only');
      return;
    }
    const packet = parsePacket(data);
    if (!packet) {
      this.ws.close(1002, 'malformed packet');
      return;
    }
    const stream = this.streams.get(packet.streamId);
    switch (packet.type) {
      case CONNECT:
        this.connect(packet.streamId, packet.payload);
        break;
      case DATA:
        if (stream) this.write(stream, packet.payload);
        break;
      case CLOSE:
        if (stream) this.closeByClient(stream);
        break;
      case CONTINUE:
        // On stream 0: what the client received in all (an extra of browser-lite, window.ts)
        if (packet.streamId === 0 && packet.payload.length >= 4) {
          this.window.onAck(packet.payload.readUInt32LE(0), Date.now());
          this.releaseHeld();
        }
        break;
      default:
        // Unknown types (Wisp v2 INFO) carry nothing for us
        break;
    }
  }

  private refuse(streamId: number, reason: number): void {
    this.send(closePacket(streamId, reason));
  }

  /** Close reason for a CONNECT the policy does not allow, null if it may connect. */
  private check(request: ConnectRequest | null): number | null {
    const { policy } = this.options;
    // An empty target is the client asking whether the connection is alive: answer at once,
    // before every other check and without logging
    if (!request?.hostname || !request.port) return Reason.invalid;
    const { streamType, hostname, port } = request;
    if (streamType !== STREAM_TCP) return Reason.blocked;
    if (!validHostname(hostname)) return Reason.invalid;
    if (!portAllowed(policy, port)) return Reason.blocked;
    if (this.streams.size + this.draining.size >= policy.streamsPerConnection)
      return Reason.throttled;
    const key = targetKey(hostname, port);
    let sameTarget = 0;
    for (const other of this.streams.values()) if (other.key === key) sameTarget++;
    return sameTarget >= policy.streamsPerHost ? Reason.throttled : null;
  }

  private connect(streamId: number, payload: Buffer): void {
    if (streamId === 0 || this.streams.has(streamId)) {
      this.ws.close(1002, 'invalid stream id');
      return;
    }
    const request = parseConnect(payload);
    const refusal = this.check(request);
    if (refusal !== null || !request) {
      this.refuse(streamId, refusal ?? Reason.invalid);
      return;
    }
    const { hostname, port } = request;
    const key = targetKey(hostname, port);
    const stream = new Stream(streamId, key);
    this.streams.set(streamId, stream);
    this.touch(stream);
    this.open(stream, hostname, port).catch((error: unknown) => {
      if (stream.closed) return;
      if (!(error instanceof ConnectError))
        this.options.logger.error('relay: connect failed', error);
      this.fail(stream, error instanceof ConnectError ? error.reason : Reason.networkError);
    });
  }

  private async open(stream: Stream, hostname: string, port: number): Promise<void> {
    const { allowAddress } = this.options;
    const addresses = await allowedAddresses(hostname, allowAddress);
    // Closed while the name was resolved: connecting now would hold a socket outside every limit
    if (stream.closed) return;
    const socket = connectSocket(hostname, port, addresses);
    stream.socket = socket;
    socket.on('connect', () => {
      // Defense in depth: the lookup only returned checked addresses
      if (!allowAddress(socket.remoteAddress ?? '')) {
        stream.failure = Reason.blocked;
        socket.destroy();
        return;
      }
      stream.connected = true;
      const pending = stream.pending;
      stream.pending = [];
      for (const data of pending) this.writeSocket(stream, data);
    });
    socket.on('data', (data: Buffer) => {
      if (stream.closed) return;
      this.touch(stream);
      this.send(dataPacket(stream.id, data));
      this.holdIfBehind(stream);
    });
    socket.on('error', (error) => {
      if (!stream.connected) stream.failure = reasonForError(error);
    });
    // Once connected every end is voluntary, a reset after data too: the engine reads it as end
    // of stream, which responses delimited by the connection close rely on
    socket.on('close', () => {
      stream.socket = null;
      this.draining.delete(stream);
      if (stream.closed) return;
      this.fail(stream, stream.connected ? Reason.voluntary : stream.failure);
    });
  }

  private write(stream: Stream, data: Buffer): void {
    if (stream.closed) return;
    this.touch(stream);
    stream.queuedBytes += data.length;
    if (
      ++stream.queued > QUEUE_LIMIT ||
      stream.queuedBytes > this.streamQueueBytes ||
      this.queuedBytes() > this.connectionQueueBytes
    ) {
      this.fail(stream, Reason.networkError);
      return;
    }
    if (stream.connected) this.writeSocket(stream, data);
    else stream.pending.push(data);
  }

  // A CONTINUE after every half buffer written; the remaining buffer accounts for what is still
  // queued, so a target that does not read stops the client
  private writeSocket(stream: Stream, data: Buffer): void {
    stream.socket?.write(data, () => {
      stream.queued--;
      stream.queuedBytes -= data.length;
      if (stream.closed || ++stream.written < BUFFER_SIZE / 2) return;
      stream.written = 0;
      this.send(continuePacket(stream.id, Math.max(0, BUFFER_SIZE - stream.queued)));
    });
  }

  private queuedBytes(): number {
    let bytes = 0;
    for (const stream of this.streams.values()) bytes += stream.queuedBytes;
    for (const stream of this.draining) bytes += stream.queuedBytes;
    return bytes;
  }

  private touch(stream: Stream): void {
    const { idleTimeoutMs } = this.options.policy;
    if (!idleTimeoutMs) return;
    if (stream.idleTimer) stream.idleTimer.refresh();
    else stream.idleTimer = setTimeout(() => this.fail(stream, Reason.timeout), idleTimeoutMs);
  }

  /** The relay ends the stream: CLOSE to the client, socket gone. */
  private fail(stream: Stream, reason: number): void {
    if (stream.closed) return;
    this.release(stream);
    stream.socket?.destroy();
    this.refuse(stream.id, reason);
  }

  // What the client sent still reaches the target, then the socket is gone; data arriving from
  // the target is dropped
  private closeByClient(stream: Stream): void {
    this.release(stream);
    this.shutdown(stream);
  }

  private shutdown(stream: Stream): void {
    const socket = stream.socket;
    if (!socket) return;
    if (!stream.connected) {
      socket.destroy();
      return;
    }
    // Counts against the limits until the socket is gone
    this.draining.add(stream);
    socket.end(() => socket.destroy());
    setTimeout(() => socket.destroy(), CLOSE_TIMEOUT_MS).unref();
  }

  private release(stream: Stream): void {
    this.held.delete(stream);
    stream.closed = true;
    stream.pending = [];
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    this.streams.delete(stream.id);
  }

  private cleanup(): void {
    for (const timer of this.timers) clearInterval(timer);
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    for (const stream of [...this.streams.values()]) {
      this.release(stream);
      stream.socket?.resume();
      this.shutdown(stream);
    }
  }
}
