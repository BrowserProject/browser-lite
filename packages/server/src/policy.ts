import ipaddr from 'ipaddr.js';

/** Limits and address rules of one relay instance. */
export interface RelayPolicy {
  /**
   * Allow loopback, private, link-local and every other non-public address. Only for tests with
   * local servers. Default false: only global unicast addresses (SSRF protection).
   */
  allowPrivateAddresses: boolean;
  /** Target ports the relay connects to, or `'any'`. Default `[80, 443, 8080, 8443]`. */
  ports: number[] | 'any';
  /** Open streams per WebSocket connection. Default 256. */
  streamsPerConnection: number;
  /** Open streams per WebSocket connection to the same host name and port. Default 64. */
  streamsPerHost: number;
  /** Open WebSocket connections per client address. Default 16. */
  connectionsPerIp: number;
  /**
   * Largest WebSocket message the relay accepts, in bytes. Default 64 KiB plus the 5 byte packet
   * header: the largest packet of WispTransport. Client data waiting for a slow target is limited
   * to 2 * 128 packets of this size per stream and at least 32 MiB per connection.
   */
  maxPayload: number;
  /** Closes a stream without traffic in either direction after this many ms; 0 never. Default 0. */
  idleTimeoutMs: number;
}

/** The policy used for every field the caller leaves out. */
export const DEFAULT_POLICY: Readonly<RelayPolicy> = Object.freeze({
  allowPrivateAddresses: false,
  ports: [80, 443, 8080, 8443],
  streamsPerConnection: 256,
  streamsPerHost: 64,
  connectionsPerIp: 16,
  maxPayload: 64 * 1024 + 5,
  idleTimeoutMs: 0,
});

function positiveInteger(name: string, value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new TypeError(
      `policy.${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    );
  return value;
}

/** Fills in defaults and validates; throws a TypeError for invalid values. */
export function resolvePolicy(policy: Partial<RelayPolicy> = {}): RelayPolicy {
  const merged = { ...DEFAULT_POLICY, ...policy };
  const { ports } = merged;
  if (
    ports !== 'any' &&
    (!Array.isArray(ports) || !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536))
  )
    throw new TypeError("policy.ports must be 'any' or an array of ports 1..65535");
  return {
    allowPrivateAddresses: merged.allowPrivateAddresses === true,
    ports: ports === 'any' ? 'any' : [...ports],
    streamsPerConnection: positiveInteger('streamsPerConnection', merged.streamsPerConnection),
    streamsPerHost: positiveInteger('streamsPerHost', merged.streamsPerHost),
    connectionsPerIp: positiveInteger('connectionsPerIp', merged.connectionsPerIp),
    maxPayload: positiveInteger('maxPayload', merged.maxPayload),
    idleTimeoutMs: positiveInteger('idleTimeoutMs', merged.idleTimeoutMs, true),
  };
}

/** True if the policy allows connecting to this target port. */
export function portAllowed(policy: RelayPolicy, port: number): boolean {
  return policy.ports === 'any' || policy.ports.includes(port);
}

/**
 * True for a global unicast address. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is converted to IPv4
 * first, so loopback, private networks, link-local, ULA (`fd00::/8`), NAT64 and similar ranges are
 * all rejected.
 */
export function isPublicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

/** Address in a form suitable as a map key: IPv4-mapped IPv6 becomes IPv4. */
export function normalizeAddress(address: string): string {
  return ipaddr.isValid(address) ? ipaddr.process(address).toString() : address;
}
