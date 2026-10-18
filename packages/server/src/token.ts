import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TOKEN_SUBPROTOCOL } from './wisp/protocol.js';

const MIN_TOKEN_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

function checkSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
    throw new TypeError(`token secret must have at least ${MIN_SECRET_LENGTH} characters`);
}

function checkAudience(audience: string): void {
  if (typeof audience !== 'string' || !audience)
    throw new TypeError('token audience must be a non-empty string');
}

const signature = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Creates a signed token `<payload>.<signature>` (base64url JSON `{ exp, aud, sub? }`,
 * HMAC-SHA256) that {@link verifyToken} accepts for the same `audience` until it expires.
 * `audience` names what the token opens, for example `'relay'` or `'profile'` (the
 * `browser-lite-server` command checks these two), so a token for one never opens the other.
 * Hand it to the client: WispTransport sends it as a WebSocket subprotocol, the profile client as
 * `Authorization: Bearer`.
 */
export function signToken(o: {
  secret: string;
  ttlSeconds: number;
  audience: string;
  subject?: string;
}): string {
  checkSecret(o.secret);
  checkAudience(o.audience);
  if (!Number.isFinite(o.ttlSeconds) || o.ttlSeconds <= 0)
    throw new TypeError('ttlSeconds must be a positive number');
  const claims: { exp: number; aud: string; sub?: string } = {
    exp: Math.floor(Date.now() / 1000 + o.ttlSeconds),
    aud: o.audience,
  };
  if (o.subject !== undefined) claims.sub = o.subject;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(o.secret, payload)}`;
}

/**
 * Checks signature, audience and expiry; returns the subject, or null for an invalid or expired
 * token or one made for another audience.
 */
export function verifyToken(
  secret: string,
  token: string,
  audience: string,
): { subject?: string } | null {
  checkSecret(secret);
  checkAudience(audience);
  if (typeof token !== 'string') return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined || !equal(mac, signature(secret, payload)))
    return null;
  let claims: { exp?: unknown; aud?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (typeof claims?.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  if (claims.aud !== audience) return null;
  return typeof claims.sub === 'string' ? { subject: claims.sub } : {};
}

/**
 * Token of a request: the WebSocket subprotocol `bl-token.<base64url>` (WispTransport) or
 * `Authorization: Bearer <token>`. Never the URL: URLs end up in proxy and access logs.
 */
function tokenOf(req: IncomingMessage): string | null {
  const offered = req.headers['sec-websocket-protocol'];
  for (const entry of typeof offered === 'string' ? offered.split(',') : []) {
    const value = entry.trim();
    if (value.startsWith(TOKEN_SUBPROTOCOL))
      return Buffer.from(value.slice(TOKEN_SUBPROTOCOL.length), 'base64url').toString();
  }
  return /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

/**
 * An `authorize` function for `createRelay` and `createProfileStore` that accepts the static
 * `token`, a token signed with `secret` for `audience` (required with `secret`), or either when
 * both are given.
 */
export function authorizeToken(o: {
  token?: string;
  secret?: string;
  audience?: string;
}): (req: IncomingMessage) => boolean {
  const { token, secret, audience } = o;
  if (token === undefined && secret === undefined)
    throw new TypeError('authorizeToken needs a token or a secret');
  if (token !== undefined && (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH))
    throw new TypeError(`token must have at least ${MIN_TOKEN_LENGTH} characters`);
  if (secret !== undefined) {
    checkSecret(secret);
    checkAudience(audience as string);
  }
  return (req) => {
    const given = tokenOf(req);
    if (given === null) return false;
    if (token !== undefined && equal(given, token)) return true;
    return secret !== undefined && verifyToken(secret, given, audience as string) !== null;
  };
}
