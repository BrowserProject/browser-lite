import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createProfileStore } from '../profile.js';
import { createRelay } from '../relay.js';
import { serveStatic } from '../static.js';
import { authorizeToken } from '../token.js';
import type { CliConfig } from './config.js';

/** The HTTP server of the command: relay, profile, site and /healthz. */
export interface App {
  server: http.Server;
  /** Stops accepting, closes relay connections, waits for profile writes. */
  close(): Promise<void>;
}

// Behind `trustProxy` proxies the client is the entry that many places from the right of
// X-Forwarded-For; entries further left are set by the client and cannot be trusted
function clientAddressFor(trustProxy: number) {
  return (req: IncomingMessage): string => {
    const remote = req.socket.remoteAddress ?? '';
    if (!trustProxy) return remote;
    const header = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return hops[hops.length - trustProxy] ?? remote;
  };
}

// Engine files live in engine/<version>/ and never change, nor do the files of a Vite build with
// the content hash in their name (assets/index-Vc6q4Bex.js), so a second visit does not ask again
const IMMUTABLE = /^\/engine\/|^\/assets\/[^/]+-[\w-]{8}\.\w+$/;
const cacheControl = (urlPath: string) =>
  IMMUTABLE.test(urlPath) ? 'public, max-age=31536000, immutable' : 'no-cache';

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );
}

/** Builds the server from the configuration; the caller listens and handles signals. */
export function createApp(config: CliConfig, logger: Pick<Console, 'warn' | 'error'>): App {
  // Signed tokens open only what their audience names; the static token opens both
  const authorizeFor = (audience: 'relay' | 'profile') =>
    config.token || config.secret
      ? authorizeToken({ token: config.token, secret: config.secret, audience })
      : () => true;
  const relay = createRelay({
    authorize: authorizeFor('relay'),
    allowedOrigins: config.allowedOrigins,
    hosts: config.hosts,
    clientAddress: clientAddressFor(config.trustProxy),
    policy: config.allowLocal ? { allowPrivateAddresses: true, ports: 'any' } : {},
    logger,
  });
  const profile = config.profileDir
    ? createProfileStore({
        dir: config.profileDir,
        maxBytes: config.profileMaxBytes,
        hosts: config.hosts,
        authorize: authorizeFor('profile'),
        logger,
      })
    : null;

  async function respond(req: IncomingMessage, res: http.ServerResponse): Promise<void> {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }
    if (profile && (await profile.handle(req, res))) return;
    if (config.siteDir && (await serveStatic(req, res, config.siteDir, { urlPath, cacheControl })))
      return;
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('browser-lite\n');
  }

  const server = http.createServer((req, res) => {
    respond(req, res).catch((error: unknown) => {
      logger.error('request failed:', error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!URL.canParse(req.url ?? '', 'http://localhost')) refuse(socket, '400 Bad Request');
    else if (!relay.handleUpgrade(req, socket, head)) refuse(socket, '404 Not Found');
  });

  return {
    server,
    async close() {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      await relay.close();
      await profile?.close();
      server.closeAllConnections();
      await stopped;
    },
  };
}
