import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { isPublicAddress, normalizeAddress, type RelayPolicy, resolvePolicy } from './policy.js';
import { WispConnection } from './wisp/connection.js';

/** Options of {@link createRelay}. */
export interface RelayOptions {
  /** URL path prefix of the WebSocket endpoint. Default `'/wisp/'`. */
  path?: string;
  /**
   * Decides whether a WebSocket upgrade may connect (required). Return `() => true` explicitly
   * for an open relay. See `authorizeToken` in `@browser-lite/server/token`.
   */
  authorize(req: IncomingMessage, url: URL): boolean | Promise<boolean>;
  /**
   * Origins allowed to connect, as full origins (`'https://example.org'`, `'*'` for any) or a
   * function. Default: the host of the `Origin` header equals the `Host` header. Requests without
   * `Origin` (non-browser clients) always pass; the check protects against cross-site WebSocket
   * hijacking, not against other clients.
   */
  allowedOrigins?: string[] | ((origin: string | undefined) => boolean);
  /**
   * Address of the client for `connectionsPerIp`. Default: the socket's remote address. Behind a
   * reverse proxy, derive it from a header the proxy sets.
   */
  clientAddress?(req: IncomingMessage): string;
  /** Limits and address rules; missing fields use the defaults of {@link RelayPolicy}. */
  policy?: Partial<RelayPolicy>;
  /** Where unexpected errors go. Default `console`. Never receives stream contents. */
  logger?: Pick<Console, 'warn' | 'error'>;
}

/** A Wisp v1 relay (TCP over WebSocket) to attach to a Node HTTP server. */
export interface Relay {
  /**
   * Handles an `upgrade` event of `node:http`. Returns false if the request path is not the
   * relay's path (the caller handles the request), true otherwise (accepted or refused).
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Refuses new connections and closes all open ones. */
  close(): Promise<void>;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function hostOf(origin: string): { protocol: string; host: string } | null {
  try {
    const url = new URL(origin);
    return { protocol: url.protocol, host: url.host.toLowerCase() };
  } catch {
    return null;
  }
}

function originCheck(allowed: RelayOptions['allowedOrigins']): (req: IncomingMessage) => boolean {
  const originOf = (req: IncomingMessage) => req.headers.origin;
  if (typeof allowed === 'function') return (req) => allowed(originOf(req));
  if (Array.isArray(allowed)) {
    const any = allowed.includes('*');
    const origins = new Set(allowed.filter((o) => o !== '*').map((o) => new URL(o).origin));
    return (req) => {
      const origin = originOf(req);
      return origin === undefined || any || origins.has(origin.toLowerCase());
    };
  }
  return (req) => {
    const origin = originOf(req);
    if (origin === undefined) return true;
    const parsed = hostOf(origin);
    if (!parsed) return false;
    let host = (req.headers.host ?? '').toLowerCase();
    const port = DEFAULT_PORTS[parsed.protocol];
    if (port && host.endsWith(`:${port}`)) host = host.slice(0, -port.length - 1);
    return parsed.host === host;
  };
}

function refuse(socket: Duplex, status: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
}

/**
 * Creates a Wisp v1 relay: browsers open TCP connections through it. Only TCP, only allowed
 * ports, only public addresses (checked on the address actually connected), limits per instance.
 */
export function createRelay(options: RelayOptions): Relay {
  if (typeof options?.authorize !== 'function')
    throw new TypeError('createRelay: options.authorize is required');
  const policy = resolvePolicy(options.policy);
  const path = options.path ?? '/wisp/';
  const logger = options.logger ?? console;
  const allowOrigin = originCheck(options.allowedOrigins);
  const clientAddress = options.clientAddress ?? ((req) => req.socket.remoteAddress ?? '');
  const allowAddress = policy.allowPrivateAddresses
    ? (address: string) => net.isIP(address) !== 0
    : isPublicAddress;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: policy.maxPayload,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const perAddress = new Map<string, number>();
  const connections = new Set<WispConnection>();
  let closed = false;

  async function accept(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (closed) return refuse(socket, '503 Service Unavailable');
    if (!allowOrigin(req)) return refuse(socket, '403 Forbidden');
    const address = normalizeAddress(clientAddress(req));
    const count = perAddress.get(address) ?? 0;
    if (count >= policy.connectionsPerIp) return refuse(socket, '429 Too Many Requests');
    perAddress.set(address, count + 1);
    socket.once('close', () => {
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left) perAddress.set(address, left);
      else perAddress.delete(address);
    });
    let allowed = false;
    try {
      allowed = (await options.authorize(req, url)) === true;
    } catch (error) {
      logger.error('relay: authorize failed', error);
    }
    if (!allowed || closed)
      return refuse(socket, closed ? '503 Service Unavailable' : '403 Forbidden');
    if (socket.destroyed) return;
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const connection = new WispConnection(ws, { policy, allowAddress, logger });
      connections.add(connection);
      connection.closed.then(() => connections.delete(connection));
    });
  }

  return {
    handleUpgrade(req, socket, head) {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return false;
      }
      if (!url.pathname.startsWith(path)) return false;
      socket.on('error', () => socket.destroy());
      accept(req, socket, head, url).catch((error: unknown) => {
        logger.error('relay: upgrade failed', error);
        socket.destroy();
      });
      return true;
    },
    async close() {
      closed = true;
      await Promise.all([...connections].map((connection) => connection.close()));
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}
