import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Reason } from './protocol.js';

/** A failed connection attempt with the Wisp close reason to report. */
export class ConnectError extends Error {
  constructor(
    readonly reason: number,
    message: string,
  ) {
    super(message);
  }
}

/** Connection Attempt Delay of RFC 8305: the next address starts while earlier attempts go on. */
const ATTEMPT_DELAY_MS = 250;

// Close reason for the last error of a connection attempt that never connected
function reasonForError(error: unknown): number {
  switch ((error as { code?: string } | undefined)?.code) {
    case 'ECONNREFUSED':
      return Reason.refused;
    case 'ETIMEDOUT':
      return Reason.noResponse;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return Reason.addressUnreachable;
    default:
      return Reason.networkError;
  }
}

/** Address order of RFC 8305 section 4: the family of the first address, then alternating. */
export function interleaveFamilies(addresses: LookupAddress[]): LookupAddress[] {
  const first = addresses[0]?.family;
  const preferred = addresses.filter(({ family }) => family === first);
  const other = addresses.filter(({ family }) => family !== first);
  const order: LookupAddress[] = [];
  for (let i = 0; i < Math.max(preferred.length, other.length); i++) {
    const a = preferred[i];
    const b = other[i];
    if (a) order.push(a);
    if (b) order.push(b);
  }
  return order;
}

/**
 * Resolves the host name and keeps only the addresses `allowAddress` accepts. The socket later
 * connects to exactly these addresses, so DNS rebinding between check and connect is impossible.
 */
export async function allowedAddresses(
  hostname: string,
  allowAddress: (address: string) => boolean,
): Promise<LookupAddress[]> {
  const family = net.isIP(hostname);
  let addresses: LookupAddress[];
  if (family) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new ConnectError(Reason.unreachableHost, 'name not resolved');
    }
  }
  const allowed = addresses.filter(({ address }) => allowAddress(address));
  if (!allowed.length) throw new ConnectError(Reason.blocked, 'address not allowed');
  return allowed;
}

/**
 * Connects to the given checked addresses like a browser (Happy Eyeballs, RFC 8305): families
 * interleaved, the next address after 250 ms or as soon as an attempt fails,
 * while earlier attempts keep running. The first connected socket wins, the others are destroyed.
 * So a slow or lossy IPv4 handshake still connects when the IPv6 address fails at once on a
 * server without IPv6. Rejects with a {@link ConnectError} when every attempt failed or `signal`
 * aborted.
 */
export function connectSocket(
  port: number,
  addresses: LookupAddress[],
  signal: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const queue = interleaveFamilies(addresses);
    const attempts = new Set<net.Socket>();
    let timer: NodeJS.Timeout | undefined;
    let lastError: unknown;
    const finish = (error?: ConnectError) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      for (const socket of attempts) socket.destroy();
      attempts.clear();
      if (error) reject(error);
    };
    const abort = () => finish(new ConnectError(Reason.voluntary, 'connect aborted'));
    const next = () => {
      clearTimeout(timer);
      const target = queue.shift();
      if (!target) {
        if (!attempts.size) finish(new ConnectError(reasonForError(lastError), 'connect failed'));
        return;
      }
      const socket = net.connect({
        host: target.address,
        family: target.family,
        port,
        noDelay: true,
      });
      attempts.add(socket);
      const failed = (error: Error) => {
        lastError = error;
        attempts.delete(socket);
        socket.destroy();
        next();
      };
      socket.on('error', failed);
      socket.once('connect', () => {
        socket.off('error', failed);
        attempts.delete(socket);
        finish();
        resolve(socket);
      });
      if (queue.length) timer = setTimeout(next, ATTEMPT_DELAY_MS);
    };
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort);
      next();
    }
  });
}
