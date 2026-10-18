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

/** Close reason for a socket error before the connection was established. */
export function reasonForError(error: unknown): number {
  const failure = error as { code?: string; errors?: { code?: string }[] } | null;
  // Several addresses (autoSelectFamily) fail with an AggregateError: the last attempt counts
  switch (failure?.code ?? failure?.errors?.at(-1)?.code) {
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
 * Connects to the given checked addresses, IPv6 and IPv4 interleaved like a browser
 * (`autoSelectFamily`), so a name with an AAAA record still works on a server without IPv6.
 */
export function connectSocket(
  hostname: string,
  port: number,
  addresses: LookupAddress[],
): net.Socket {
  const first = addresses[0] as LookupAddress;
  return net.connect({
    host: hostname,
    port,
    noDelay: true,
    autoSelectFamily: true,
    lookup: (_name, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    },
  });
}
