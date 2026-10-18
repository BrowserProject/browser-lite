import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RelayOptions } from './relay.js';

const MIN_TOKEN_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

function checkSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
    throw new TypeError(`token secret must have at least ${MIN_SECRET_LENGTH} characters`);
}

const signature = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Creates a signed token `<payload>.<signature>` (base64url JSON `{ exp, sub? }`, HMAC-SHA256)
 * that {@link verifyToken} accepts until it expires. Hand it to the client, which passes it as
 * `?token=` (WispTransport) or `Authorization: Bearer` (profile).
 */
export function signToken(o: { secret: string; ttlSeconds: number; subject?: string }): string {
  checkSecret(o.secret);
  if (!Number.isFinite(o.ttlSeconds) || o.ttlSeconds <= 0)
    throw new TypeError('ttlSeconds must be a positive number');
  const claims: { exp: number; sub?: string } = {
    exp: Math.floor(Date.now() / 1000 + o.ttlSeconds),
  };
  if (o.subject !== undefined) claims.sub = o.subject;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(o.secret, payload)}`;
}

/** Checks signature and expiry; returns the subject, or null for an invalid or expired token. */
export function verifyToken(secret: string, token: string): { subject?: string } | null {
  checkSecret(secret);
  if (typeof token !== 'string') return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined || !equal(mac, signature(secret, payload)))
    return null;
  let claims: { exp?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (typeof claims?.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  return typeof claims.sub === 'string' ? { subject: claims.sub } : {};
}

/** Token of a request: `?token=` or `Authorization: Bearer <token>`. */
function tokenOf(req: IncomingMessage, url: URL): string | null {
  return (
    url.searchParams.get('token') ??
    /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ??
    null
  );
}

/**
 * An `authorize` function for {@link createRelay} (and `createProfileStore`) that accepts the
 * static `token`, a token signed with `secret`, or either when both are given.
 */
export function authorizeToken(o: { token?: string; secret?: string }): RelayOptions['authorize'] {
  const { token, secret } = o;
  if (token === undefined && secret === undefined)
    throw new TypeError('authorizeToken needs a token or a secret');
  if (token !== undefined && (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH))
    throw new TypeError(`token must have at least ${MIN_TOKEN_LENGTH} characters`);
  if (secret !== undefined) checkSecret(secret);
  return (req, url) => {
    const given = tokenOf(req, url);
    if (given === null) return false;
    if (token !== undefined && equal(given, token)) return true;
    return secret !== undefined && verifyToken(secret, given) !== null;
  };
}
